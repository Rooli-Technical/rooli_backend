import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import {
  ISocialProvider,
  SocialCredentials,
} from '../interfaces/social-provider.interface';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class FacebookProvider implements ISocialProvider {
  private readonly logger = new Logger(FacebookProvider.name);
  private readonly GRAPH_URL = 'https://graph.facebook.com/v23.0';

  constructor(
    @InjectQueue('post-verification')
    private readonly postVerificationQueue: Queue,
  ) {}

  async publish(
    credentials: SocialCredentials,
    content: string,
    mediaFiles: {
      url: string;
      mimeType: string;
      metadata?: { width?: number; height?: number; durationSeconds?: number };
    }[],
    metadata?: { pageId: string; postType?: 'FEED' | 'REEL' | 'STORY' },
  ) {
    const pageId = metadata?.pageId;
    if (!pageId) throw new BadRequestException('Facebook requires a Page ID.');

    const accessToken = credentials.accessToken;
    const postType = metadata?.postType || 'FEED';

    this.logger.log(`Preparing Facebook ${postType} for Page ${pageId}...`);

    const videoFiles = mediaFiles.filter((f) =>
      f.mimeType.startsWith('video/'),
    );
    const imageFiles = mediaFiles.filter((f) =>
      f.mimeType.startsWith('image/'),
    );

    // ===============================
    // ROUTE 1: REELS (Video Only)
    // ===============================
    if (postType === 'REEL') {
      if (videoFiles.length !== 1) {
        throw new BadRequestException('Reels require exactly 1 video.');
      }

      const video = videoFiles[0];

      // Optional: Metadata Validation
      if (video.metadata) {
        const { durationSeconds, width, height } = video.metadata;

        if (durationSeconds && (durationSeconds < 3 || durationSeconds > 90)) {
          throw new BadRequestException(
            `Reel duration must be between 3s and 90s. Current: ${durationSeconds}s`,
          );
        }

        if (width && height) {
          const ratio = width / height;
          if (ratio < 0.5 || ratio > 0.6) {
            throw new BadRequestException(
              'Reels must be vertical (approx. 9:16 aspect ratio). Please crop your video.',
            );
          }
        }
      }

      return this.postReel(pageId, accessToken, content, video.url);
    }

    // ===============================
    // ROUTE 2: STORIES (Photo or Video, Single Item)
    // ===============================
    if (postType === 'STORY') {
      if (mediaFiles.length !== 1) {
        throw new BadRequestException(
          'Stories require exactly 1 media file (photo or video).',
        );
      }

      const file = mediaFiles[0];
      if (file.mimeType.startsWith('video/')) {
        return this.postVideoStory(pageId, accessToken, file.url);
      } else {
        return this.postPhotoStory(pageId, accessToken, file.url);
      }
    }

    // ===============================
    // ROUTE 3: STANDARD FEED
    // ===============================
    if (videoFiles.length > 0 && imageFiles.length > 0) {
      throw new BadRequestException('Feed posts cannot mix videos and images.');
    }

    if (videoFiles.length > 1) {
      throw new BadRequestException('Feed posts can have at most 1 video.');
    }

    // CASE A: Video Post
    if (videoFiles.length === 1) {
      return this.postVideo(pageId, accessToken, content, videoFiles[0].url);
    }

    // CASE B: Multiple Images (Carousel)
    if (imageFiles.length > 1) {
      return this.postMultiPhoto(pageId, accessToken, content, imageFiles);
    }

    // CASE C: Single Image
    if (imageFiles.length === 1) {
      return this.postSinglePhoto(
        pageId,
        accessToken,
        content,
        imageFiles[0].url,
      );
    }

    // CASE D: Text Only
    return this.postText(pageId, accessToken, content);
  }

  async editContent(accessToken: string, id: string, newContent: string) {
    try {
      this.logger.log(`Editing Facebook content ${id}...`);
      const url = `${this.GRAPH_URL}/${id}`;

      const response = await axios.post(url, {
        message: newContent,
        access_token: accessToken,
      });

      return { success: response.data.success || true };
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async deleteContent(accessToken: string, id: string) {
    try {
      this.logger.log(`Deleting Facebook content ${id}...`);
      const url = `${this.GRAPH_URL}/${id}`;

      const response = await axios.delete(url, {
        params: { access_token: accessToken },
      });

      return { success: response.data.success || true };
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // ==================================================
  // 🖼️ SCENARIO: Multiple Photos (Carousel)
  // ==================================================
  private async postMultiPhoto(
    pageId: string,
    token: string,
    caption: string,
    files: { url: string }[],
  ) {
    this.logger.log(`Uploading ${files.length} photos as unpublished...`);

    // Step 1: Upload all photos as "unpublished" to get IDs
    // We use Promise.all to do this in parallel for speed
    const mediaIds = await Promise.all(
      files.map((file) => this.uploadUnpublishedPhoto(pageId, token, file.url)),
    );

    // Step 2: Create a Feed Post attaching these IDs
    const attachments = mediaIds.map((id) => ({ media_fbid: id }));

    const url = `${this.GRAPH_URL}/${pageId}/feed`;
    const response = await axios.post(url, {
      message: caption,
      attached_media: attachments,
      access_token: token,
    });

    return this.formatResult(response.data.id, pageId);
  }

  // ==================================================
  // 📸 SCENARIO: Single Photo
  // ==================================================
  private async postSinglePhoto(
    pageId: string,
    token: string,
    caption: string,
    imageUrl: string,
  ) {
    const url = `${this.GRAPH_URL}/${pageId}/photos`;
    const response = await axios.post(url, {
      url: imageUrl,
      message: caption,
      access_token: token,
    });

    return this.formatResult(response.data.post_id || response.data.id, pageId);
  }

  // ==================================================
  // 📝 SCENARIO: Text Only
  // ==================================================
  private async postText(pageId: string, token: string, message: string) {
    const url = `${this.GRAPH_URL}/${pageId}/feed`;
    const response = await axios.post(url, {
      message: message,
      access_token: token,
    });

    return this.formatResult(response.data.id, pageId);
  }

  // ==================================================
  // 🎬 REELS (Target: /video_reels)
  // ==================================================
  private async postReel(
    pageId: string,
    token: string,
    caption: string,
    videoUrl: string,
  ) {
    const reelsUrl = `${this.GRAPH_URL}/${pageId}/video_reels`;

    // 1) START
    const startRes = await axios.post(reelsUrl, null, {
      params: { upload_phase: 'start', access_token: token },
    });

    const { video_id, upload_url } = startRes.data;

    // 2) UPLOAD remote URL to rupload
    await axios.post(upload_url, null, {
      headers: {
        Authorization: `OAuth ${token}`,
        file_url: videoUrl,
      },
      maxBodyLength: Infinity,
    });

    // 3) FINISH (publish)
    const finishRes = await axios.post(reelsUrl, null, {
      params: {
        upload_phase: 'finish',
        video_id,
        video_state: 'PUBLISHED',
        description: caption,
        access_token: token,
      },
    });

    const finalPostId = finishRes.data.post_id;
    
    if (!finalPostId) {
      this.logger.log(`Reel ${video_id} is processing. Queuing Post ID fetch...`);
      await this.postVerificationQueue.add(
        'fetch-real-post-id', 
        { platform: 'FACEBOOK', mediaId: video_id, pageId, accessToken: token },
        { 
          delay: 60000, 
          attempts: 5, 
          backoff: { type: 'exponential', delay: 60000 },
          removeOnComplete: true,
        }
      );
    }

    // Return what we have! (Our formatResult handles it cleanly)
    return this.formatResult(finalPostId ?? video_id, pageId);
  }

  // ==================================================
  // 📖 STORIES (Target: /photo_stories or /video_stories)
  // ==================================================
  private async postPhotoStory(
    pageId: string,
    token: string,
    imageUrl: string,
  ) {
    // Step 1: upload photo UNPUBLISHED to get photo_id
    const uploadRes = await axios.post(
      `${this.GRAPH_URL}/${pageId}/photos`,
      null,
      {
        params: {
          url: imageUrl,
          published: false,
          access_token: token,
        },
      },
    );

    const photoId = uploadRes.data.id;
    if (!photoId)
      throw new Error(`Photo upload failed: ${JSON.stringify(uploadRes.data)}`);

    // Step 2: create story using photo_id
    const storyRes = await axios.post(
      `${this.GRAPH_URL}/${pageId}/photo_stories`,
      null,
      {
        params: {
          photo_id: photoId,
          access_token: token,
        },
      },
    );


    return {
      platformPostId: storyRes.data.post_id ?? storyRes.data.id ?? photoId,
      url: `https://facebook.com/${pageId}`,
    };
  }

  private async postVideoStory(
    pageId: string,
    token: string,
    videoUrl: string,
  ) {
    const storiesUrl = `${this.GRAPH_URL}/${pageId}/video_stories`;

    // 1) START
    const startRes = await axios.post(storiesUrl, null, {
      params: { upload_phase: 'start', access_token: token },
    });

    const { video_id, upload_url } = startRes.data;
    if (!video_id || !upload_url) {
      throw new Error(
        `Video story start failed: ${JSON.stringify(startRes.data)}`,
      );
    }

    // 2) UPLOAD remote URL to rupload
    await axios.post(upload_url, null, {
      headers: {
        Authorization: `OAuth ${token}`,
        file_url: videoUrl,
      },
      maxBodyLength: Infinity,
    });

    // 3) FINISH (publish)
    const finishRes = await axios.post(storiesUrl, null, {
      params: { upload_phase: 'finish', video_id, access_token: token },
    });


    return {
      platformPostId: finishRes.data.post_id ?? video_id,
      url: `https://facebook.com/${pageId}`,
    };
  }

  // --------------------------------------------------
  // Helpers
  // --------------------------------------------------

  private async uploadUnpublishedPhoto(
    pageId: string,
    token: string,
    imageUrl: string,
  ): Promise<string> {
    const url = `${this.GRAPH_URL}/${pageId}/photos`;
    const response = await axios.post(url, {
      url: imageUrl,
      published: false, // 👈 Critical for carousels
      access_token: token,
    });
    return response.data.id;
  }

  private formatResult(postId: string, pageId: string) {
    // Facebook IDs can be "PageID_PostID" or just "PostID" depending on the endpoint
    const cleanId = postId.includes('_') ? postId : `${pageId}_${postId}`;

    return {
      platformPostId: cleanId,
      // URL format: https://facebook.com/{PageID}/posts/{PostID}
      // Note: Videos sometimes have a different URL structure, but this usually redirects correctly.
      url: `https://facebook.com/${cleanId.replace('_', '/posts/')}`,
    };
  }

  private async postVideo(
    pageId: string,
    token: string,
    caption: string,
    videoUrl: string,
  ) {
    const url = `${this.GRAPH_URL}/${pageId}/videos`;

    // 1. Upload the video to Meta
    const response = await axios.post(url, {
      description: caption,
      file_url: videoUrl,
      access_token: token,
    });

    const videoId = response.data.id; 

    // 2. Add to Queue with the 1-Minute Delay & Exponential Backoff
    await this.postVerificationQueue.add(
      'fetch-real-post-id',
      {
        platform: 'FACEBOOK',
        mediaId: videoId,
        pageId: pageId,
        accessToken: token,
      },
      {
        delay: 60000,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 60000,
        },
        removeOnComplete: true,
      },
    );

    // 3. Return the Media ID instantly so the user isn't kept waiting
    return this.formatResult(videoId, pageId);
  }

  private handleError(error: any) {
    const msg = error.response?.data?.error?.message || error.message;
    this.logger.error('Facebook API Error', error.response?.data);
    throw new InternalServerErrorException(`Facebook Failed: ${msg}`);
  }
}
