import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { TwitterApi, EUploadMimeType, SendTweetV2Params } from 'twitter-api-v2';

import { BasePlatformService } from './base-platform.service';
import {
  ScheduledPost,
  PublishingResult,
  TwitterScheduledPost,
} from '../interfaces/social-scheduler.interface';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TwitterPlatformService extends BasePlatformService {
  readonly platform = 'X';
  private readonly appKey: string;
  private readonly appSecret: string;

  constructor(
    http: HttpService,
    private readonly configService: ConfigService,
  ) {
    super(http);
    this.appKey = this.configService.get<string>('X_API_KEY');
    this.appSecret = this.configService.get<string>('X_API_SECRET');

    if (!this.appKey || !this.appSecret) {
      throw new Error('Twitter API credentials missing in config');
    }
  }

  // ===========================================================================
  // PUBLIC METHODS
  // ===========================================================================


  async schedulePost(post: TwitterScheduledPost): Promise<PublishingResult> {
    return this.makeApiRequest(async () => {
      this.validatePost(post);
      return { success: true };
    }, 'validate Twitter post');
  }

async publishImmediately(post: TwitterScheduledPost): Promise<PublishingResult> {
    return this.makeApiRequest(async () => {
      this.validatePost(post);
      const client = this.getClient(post.accessToken);

      // CASE A: IT IS A THREAD
      if (post.threadItems && post.threadItems.length > 0) {
         return this.handleThread(client, post);
      }

      // CASE B: SINGLE TWEET
      return this.handleSingleTweet(client, post);

    }, 'publish to Twitter');
  }

  async deleteScheduledPost(postId: string, accessToken: string): Promise<boolean> {
    return this.makeApiRequest(async () => {
      if (!postId) throw new Error('Post ID is required');
      
      const client = this.getClient(accessToken);
      
      this.logger.log(`Deleting Tweet: ${postId}`);
      const result = await client.v2.deleteTweet(postId);

      if (!result.data?.deleted) {
        throw new Error('Twitter API reported deletion failed');
      }

      return true;
    }, 'delete Twitter tweet');
  }

  // ===========================================================================
  // THREAD HANDLER (New)
  // ===========================================================================

  private async handleThread(client: TwitterApi, post: TwitterScheduledPost) {
    this.logger.log(`Publishing Thread (${post.threadItems.length + 1} tweets)...`);

    //  Prepare Root Tweet Payload
    const rootPayload = await this.prepareTweetPayload(client, post.content, post.mediaUrls);
    
    // Prepare Child Tweets Payloads
    const threadPayloads: SendTweetV2Params[] = [rootPayload];

    for (const child of post.threadItems) {
      const childPayload = await this.prepareTweetPayload(client, child.content, child.mediaUrls);
      threadPayloads.push(childPayload);
    }

    //  Execute Atomic Thread
    // twitter-api-v2 handles the chaining (reply_id) automatically
    const result = await client.v2.tweetThread(threadPayloads);

    if (!result || result.length === 0) {
      throw new Error('Thread creation failed');
    }

    // Return the ID of the ROOT tweet
    const rootTweet = result[0].data;
    
    return {
      success: true,
      platformPostId: rootTweet.id,
      publishedAt: new Date(),
      metadata: { 
        threadIds: result.map(t => t.data.id), // Save all IDs
        rootId: rootTweet.id 
      },
    };
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Helper to create an authenticated Twitter Client.
   * Expects 'accessToken' to be "TOKEN:SECRET"
   */
  private getClient(compositeToken: string): TwitterApi {
    const [token, secret] = compositeToken.split(':');

    if (!token || !secret) {
      throw new Error('Invalid Twitter Token format. Expected "token:secret"');
    }

    return new TwitterApi({
      appKey: this.appKey,
      appSecret: this.appSecret,
      accessToken: token,
      accessSecret: secret,
    });
  }

  /**
   * Refactored logic to prepare params for ANY tweet (Root or Child)
   */
 private async prepareTweetPayload(
    client: TwitterApi, 
    content: string, 
    mediaUrls: string[] = []
  ): Promise<SendTweetV2Params> {
    
    const params: SendTweetV2Params = { text: content || '' };
    const mediaIds: string[] = [];

    if (mediaUrls.length > 0) {
      this.validateMediaRules(mediaUrls); // Ensures max 4 items
      for (const url of mediaUrls) {
        const mediaId = await this.uploadMedia(client, url);
        if (mediaId) mediaIds.push(mediaId);
      }
    }

    if (mediaIds.length > 0) {
      // FIX: Cast string[] to the specific tuple type Twitter expects
      params.media = { 
        media_ids: mediaIds as unknown as [string] | [string, string] | [string, string, string] | [string, string, string, string] 
      };
    }

    return params;
  }

  private async handleSingleTweet(client: TwitterApi, post: TwitterScheduledPost) {
    const params = await this.prepareTweetPayload(client, post.content, post.mediaUrls);
    const result = await client.v2.tweet(params);
    
    return {
      success: true,
      platformPostId: result.data.id,
      publishedAt: new Date(),
      metadata: result.data,
    };
  }

  /**
   * Downloads file from CDN and uploads to Twitter using v1.1 API.
   * Twitter requires binary buffer or path.
   */
private async uploadMedia(client: TwitterApi, url: string): Promise<string> {
    this.logger.debug(`Downloading media from Cloudinary: ${url}`);

    // Download to Buffer
    const response = await firstValueFrom(
      this.http.get(url, { responseType: 'arraybuffer' })
    );
    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'];

    // Detect MIME Type
    const mimeType = this.getMimeType(contentType, url);
    
    // Determine if Video (Check Mime OR Cloudinary URL pattern)
    const isVideo = mimeType.startsWith('video') || url.includes('/video/');

    this.logger.debug(`Detected Type: ${mimeType} | Is Video? ${isVideo}`);

    // Upload to Twitter
    // CRITICAL: Type must be 'tweet_video' for MP4s, or Twitter rejects it.
    const mediaId = await client.v1.uploadMedia(buffer, {
      mimeType: mimeType as EUploadMimeType,
      type: isVideo ? 'tweet_video' : 'tweet_image',
      target: 'tweet'
    });

    // Wait for Processing (Required for Videos)
    if (isVideo) {
      await this.waitForProcessing(client, mediaId);
    }

    return mediaId;
  }

  private validatePost(post: any) {
    if (!post.accessToken) throw new Error('Access Token required');
    if (!post.content && (!post.mediaUrls || post.mediaUrls.length === 0)) {
      throw new Error('Tweet requires text content or media');
    }
  }

  private validateMediaRules(urls: string[]) {
   if (urls.length > 4) {
      throw new Error('Twitter supports a maximum of 4 media items per tweet.');
    }
  }


private getMimeType(headerType: string, url: string): string {
    // 1. Clean the URL
    const lowerUrl = url.toLowerCase();

    // 2. CLOUDINARY SPECIFIC CHECK
    if (lowerUrl.includes('/video/upload/') || lowerUrl.includes('/video/private/')) {
       // Default to mp4 if we know it's a Cloudinary video but don't have an extension
       return 'video/mp4';
    }

    // 3. Trust the header ONLY if it is specific
    if (headerType && headerType !== 'application/octet-stream') {
      return headerType;
    }

    // 4. Extension Detection
    if (lowerUrl.endsWith('.mp4')) return 'video/mp4';
    if (lowerUrl.endsWith('.mov')) return 'video/quicktime';
    if (lowerUrl.endsWith('.avi')) return 'video/x-msvideo';
    
    // Images
    if (lowerUrl.endsWith('.jpg') || lowerUrl.endsWith('.jpeg')) return 'image/jpeg';
    if (lowerUrl.endsWith('.png')) return 'image/png';
    if (lowerUrl.endsWith('.gif')) return 'image/gif';
    if (lowerUrl.endsWith('.webp')) return 'image/webp';

    // 5. Fallback (Twitter defaults to treating this as an image, which causes the crash if it's actually a video)
    return 'image/jpeg'; 
  }

  private async waitForProcessing(client: TwitterApi, mediaId: string): Promise<void> {
    this.logger.log(`Waiting for Twitter video processing: ${mediaId}`);
    
    // Max wait: 60 seconds (usually takes 5-10s)
    const maxRetries = 20; 
    let retries = 0;

    while (retries < maxRetries) {
      // Fetch Status
      const info = await client.v1.mediaInfo(mediaId);
      const processingInfo = info.processing_info;

      // If no processing_info, it means it's done or wasn't required (small files)
      if (!processingInfo) return;

      const state = processingInfo.state;

      if (state === 'succeeded') {
        this.logger.debug(`Video ${mediaId} processed successfully.`);
        return;
      }

      if (state === 'failed') {
        const error = processingInfo.error?.message || 'Unknown error';
        throw new Error(`Twitter Video Processing Failed: ${error}`);
      }

      // Twitter tells us how long to wait (check_after_secs), default to 2s
      const waitSecs = processingInfo.check_after_secs || 2;
      await new Promise(r => setTimeout(r, waitSecs * 1000));
      
      retries++;
    }

    throw new Error('Twitter video processing timed out');
  }
}
