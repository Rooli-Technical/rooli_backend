import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { ISocialProvider, SocialCredentials } from '../interfaces/social-provider.interface';

@Injectable()
export class InstagramProvider implements ISocialProvider {
  private readonly logger = new Logger(InstagramProvider.name);
  private readonly GRAPH_URL = 'https://graph.facebook.com/v23.0';

  async publish(
    credentials: SocialCredentials,
    content: string,
    mediaFiles: { url: string; mimeType: string; coverUrl?: string }[],
    metadata?: { instagramUserId: string; postType?: 'FEED' | 'REEL' | 'STORY' },
  ) {
    // 1. Validate IG User ID
    // Note: This is the "Instagram Business Account ID", NOT the Page ID or username.
    const igUserId = metadata?.instagramUserId;
    if (!igUserId) throw new BadRequestException('Instagram Business Account ID is required.');

    const accessToken = credentials.accessToken;
    const postType = metadata?.postType || 'FEED';

    try {
      this.logger.log(`Preparing Instagram ${postType} for Account ${igUserId}...`);

      const videoCount = mediaFiles.filter((f) => f.mimeType.startsWith('video/')).length;
      const imageCount = mediaFiles.filter((f) => f.mimeType.startsWith('image/')).length;

    // ROUTE 1: REELS
      if (postType === 'REEL') {
        if (videoCount !== 1) throw new BadRequestException('Reels must contain exactly 1 video.');
        const file = mediaFiles[0];
        // Pass true for isVideo
        return this.publishMedia(igUserId, accessToken, mediaFiles[0].url, content, 'REELS', true, file.coverUrl);
      }

      // ROUTE 2: STORIES
      if (postType === 'STORY') {
        if (mediaFiles.length !== 1) throw new BadRequestException('Stories must contain exactly 1 item.');
        const file = mediaFiles[0];
        const isVideo = file.mimeType.startsWith('video/');
        // Pass dynamic isVideo
        return this.publishMedia(igUserId, accessToken, file.url, '', 'STORIES', isVideo);
      }

      // ROUTE 3: FEED - Single Items
      if (videoCount === 1) {
        return this.publishMedia(igUserId, accessToken, content, mediaFiles[0].url, 'VIDEO', true);
      }

      if (imageCount === 1) {
        return this.publishMedia(igUserId, accessToken, content, mediaFiles[0].url, 'IMAGE', false);
      }

      // =========================================================
      // 📰 ROUTE 3: FEED (Standard)
      // =========================================================
      
      // A. Carousel (Album)
      if (mediaFiles.length > 1) {
        if (mediaFiles.length > 10) throw new BadRequestException('Instagram allows max 10 items per carousel.');
        return this.publishCarousel(igUserId, accessToken, content, mediaFiles);
      }

    } catch (error) {
      this.handleError(error);
    }
  }

// ==================================================
  // 📸 SINGLE MEDIA (Image, Video, Reel, Story)
  // ==================================================
  private async publishMedia(
    igUserId: string,
    token: string,
    caption: string,
    mediaUrl: string,
    // The "Target" format we want on Instagram
    targetType: 'IMAGE' | 'VIDEO' | 'REELS' | 'STORIES', 
    // The actual file type (we infer this from the usage)
    isVideo: boolean, 
    coverUrl?: string
  ) {
    // Step 1: Create Container
    const containerId = await this.createContainer(
      igUserId, 
      token, 
      mediaUrl, 
      targetType, 
      isVideo, 
      caption,
      false, // isCarouselItem
      coverUrl // 👈 Pass it down
    );

    // Step 2: Publish Container
    return this.publishContainer(igUserId, token, containerId);
  }

  // ==================================================
  // 🛠️ HELPER: Create Container (Staging)
  // ==================================================
  private async createContainer(
    igUserId: string,
    token: string,
    mediaUrl: string,
    targetType: 'IMAGE' | 'VIDEO' | 'REELS' | 'STORIES',
    isVideo: boolean,
    caption: string,
    isCarouselItem = false,
    coverUrl?: string
  ): Promise<string> {
    const url = `${this.GRAPH_URL}/${igUserId}/media`;
    
    const body: any = {
      access_token: token,
      caption: caption,
    };

    // 1. Assign URL to correct field
    if (isVideo) {
      body.video_url = mediaUrl;
      if (coverUrl) {
        body.cover_url = coverUrl; 
      }
    } else {
      body.image_url = mediaUrl;
    }

    // 2. Set the correct 'media_type' for the API
    if (targetType === 'REELS') {
      body.media_type = 'REELS';
    } else if (targetType === 'STORIES') {
      body.media_type = 'STORIES';
    } else if (isVideo) {
      body.media_type = 'VIDEO';
    } else {
      // For standard images, usually we don't send media_type, 
      // or we send 'IMAGE' only if required by specific version.
      // v19.0+ infers it from image_url usually, but let's be explicit if needed.
    }

    // 3. Carousel Flag
    if (isCarouselItem) {
      body.is_carousel_item = true;
    }

    this.logger.log(`Creating IG Container (Target: ${targetType}, Video: ${isVideo})...`);
    
    const response = await axios.post(url, body);
    const containerId = response.data.id;

    // 🛑 CRITICAL: Wait for Video Processing
    if (isVideo) {
      await this.waitForProcessing(containerId, token);
    }

    return containerId;
  }

  // ==================================================
  // 🎠 CAROUSEL (Mixed Images/Videos)
  // ==================================================
  private async publishCarousel(
    igUserId: string,
    token: string,
    caption: string,
    files: { url: string; mimeType: string, coverUrl?: string }[],
  ) {
    // Step 1: Create a Container for EACH item (Children)
    // Note: Carousel children do NOT have captions. Only the parent does.
    const childIds: string[] = [];
    
    for (const file of files) {
      const type = file.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE';
      const isVideo = file.mimeType.startsWith('video/');
      const childId = await this.createContainer(igUserId, token, file.url, type, isVideo, '', true, file.coverUrl); // isCarouselItem=true
      childIds.push(childId);
    }

    // Step 2: Create the Parent Carousel Container
    this.logger.log(`Creating Carousel Parent with ${childIds.length} items...`);
    const url = `${this.GRAPH_URL}/${igUserId}/media`;
    
    const response = await axios.post(url, {
      media_type: 'CAROUSEL',
      children: childIds, // Array of creation_ids
      caption: caption,
      access_token: token,
    });
    
    const parentContainerId = response.data.id;

    // Step 3: Publish Parent
    return this.publishContainer(igUserId, token, parentContainerId);
  }

  // ==================================================
  // 🛠️ HELPER: Publish Container (The "Go Live" Step)
  // ==================================================
  private async publishContainer(igUserId: string, token: string, containerId: string) {
    const url = `${this.GRAPH_URL}/${igUserId}/media_publish`;
    
    this.logger.log(`Publishing IG Container ${containerId}...`);
    
    const response = await axios.post(url, {
      creation_id: containerId,
      access_token: token,
    });

    return {
      platformPostId: response.data.id,
      // Note: IG API doesn't return the public URL immediately, 
      // but standard format is usually predictable or fetched via another call.
      url: `https://www.instagram.com/p/${response.data.id}/`, // Approximate
    };
  }

  // ==================================================
  // ⏳ HELPER: Wait for Status "FINISHED"
  // ==================================================
  private async waitForProcessing(containerId: string, token: string) {
    let attempts = 0;
    const maxAttempts = 10; // Wait up to ~50 seconds
    const delayMs = 5000;   // Check every 5 seconds

    while (attempts < maxAttempts) {
      const url = `${this.GRAPH_URL}/${containerId}`;
      const response = await axios.get(url, {
        params: { fields: 'status_code,status', access_token: token },
      });

      const status = response.data.status_code; // FINISHED, IN_PROGRESS, ERROR

      if (status === 'FINISHED') {
        return true;
      }
      if (status === 'ERROR') {
        throw new InternalServerErrorException('Instagram failed to process video.');
      }

      this.logger.debug(`Container ${containerId} is ${status}. Waiting...`);
      await new Promise(r => setTimeout(r, delayMs));
      attempts++;
    }

    throw new InternalServerErrorException('Instagram video processing timed out.');
  }

  private handleError(error: any) {
    const msg = error.response?.data?.error?.message || error.message;
    this.logger.error('Instagram API Error', error.response?.data);
    throw new InternalServerErrorException(`Instagram Failed: ${msg}`);
  }
}