import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { ISocialProvider, SocialCredentials } from '../interfaces/social-provider.interface';

@Injectable()
export class FacebookProvider implements ISocialProvider {
  private readonly logger = new Logger(FacebookProvider.name);
  private readonly GRAPH_URL = 'https://graph.facebook.com/v23.0';

 async publish(
  credentials: SocialCredentials,
  content: string,
  mediaFiles: { url: string; mimeType: string; metadata?: { width?: number; height?: number; durationSeconds?: number } }[],
  metadata?: { pageId: string; postType?: 'FEED' | 'REEL' | 'STORY' },
) {
  const pageId = metadata?.pageId;
  if (!pageId) throw new BadRequestException('Facebook requires a Page ID.');

  const accessToken = credentials.accessToken;
  const postType = metadata?.postType || 'FEED';

  this.logger.log(`Preparing Facebook ${postType} for Page ${pageId}...`);

  const videoFiles = mediaFiles.filter(f => f.mimeType.startsWith('video/'));
  const imageFiles = mediaFiles.filter(f => f.mimeType.startsWith('image/'));

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
        throw new BadRequestException(`Reel duration must be between 3s and 90s. Current: ${durationSeconds}s`);
      }

      if (width && height) {
        const ratio = width / height;
        if (ratio < 0.50 || ratio > 0.60) {
          throw new BadRequestException('Reels must be vertical (approx. 9:16 aspect ratio). Please crop your video.');
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
      throw new BadRequestException('Stories require exactly 1 media file (photo or video).');
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
    return this.postSinglePhoto(pageId, accessToken, content, imageFiles[0].url);
  }

  // CASE D: Text Only
  return this.postText(pageId, accessToken, content);
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
  private async postReel(pageId: string, token: string, caption: string, videoUrl: string) {
    // Note: Facebook Reels API has a 3-step initialization flow for binary uploads,
    // BUT for "Cloud Urls" we can use the `video_reels` endpoint with `video_url`.
    const url = `${this.GRAPH_URL}/${pageId}/video_reels`;

    // 1. Initialize & Upload URL
    const response = await axios.post(url, {
      video_url: videoUrl,
      description: caption, // Reel caption
      upload_phase: 'start',
      access_token: token,
    });

    const videoId = response.data.video_id;

    // 2. Check Status (Optional but recommended)
    // For MVP, since we provide a URL, Facebook handles the fetch asynchronously.
    // It might take a moment to appear.

    // 3. Publish (If not auto-published by the URL method)
    // Usually, providing video_url + upload_phase='finish' or just hitting the endpoint triggers it.
    // The safest "One-Shot" method for URLs:
    
    return {
      platformPostId: videoId,
      url: `https://www.facebook.com/reel/${videoId}`,
    };
  }

  // ==================================================
  // 📖 STORIES (Target: /photo_stories or /video_stories)
  // ==================================================
  private async postPhotoStory(pageId: string, token: string, imageUrl: string) {
    const url = `${this.GRAPH_URL}/${pageId}/photo_stories`;
    
    const response = await axios.post(url, {
      url: imageUrl,
      published: true,
      access_token: token,
    });

    return {
      platformPostId: response.data.post_id || response.data.id,
      url: `https://facebook.com/${pageId}`, // Stories don't have permanent public URLs
    };
  }

  private async postVideoStory(pageId: string, token: string, videoUrl: string) {
    const url = `${this.GRAPH_URL}/${pageId}/video_stories`;
    
    const response = await axios.post(url, {
      url: videoUrl,
      published: true,
      access_token: token,
    });

    return {
      platformPostId: response.data.post_id || response.data.id,
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
      platformPostId: postId,
      // URL format: https://facebook.com/{PageID}/posts/{PostID}
      // Note: Videos sometimes have a different URL structure, but this usually redirects correctly.
      url: `https://facebook.com/${cleanId.replace('_', '/posts/')}`,
    };
  }

  private async postVideo(pageId: string, token: string, caption: string, videoUrl: string) {
      // Standard Feed Video
      const url = `${this.GRAPH_URL}/${pageId}/videos`;
      const response = await axios.post(url, {
        description: caption,
        file_url: videoUrl,
        access_token: token,
      });
      return this.formatResult(response.data.id, pageId);
  }

  private handleError(error: any) {
    const msg = error.response?.data?.error?.message || error.message;
    this.logger.error('Facebook API Error', error.response?.data);
    throw new InternalServerErrorException(`Facebook Failed: ${msg}`);
  }
}