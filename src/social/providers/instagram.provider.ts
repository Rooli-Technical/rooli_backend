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

@Injectable()
export class InstagramProvider implements ISocialProvider {
  private readonly logger = new Logger(InstagramProvider.name);

  async publish(
    credentials: SocialCredentials,
    content: string,
    mediaFiles: { url: string; mimeType: string; coverUrl?: string }[],
    metadata?: {
      pageId: string;
      postType?: 'FEED' | 'REEL' | 'STORY';
    },
  ) {
    // 1. Validate IG User ID
    // Note: This is the "Instagram Business Account ID", NOT the Page ID or username.
    const igUserId = metadata?.pageId;
    if (!igUserId)
      throw new BadRequestException(
        'Instagram Business Account ID is required.',
      );

    const accessToken = credentials.accessToken;
    const postType = metadata?.postType || 'FEED';

    try {
      this.logger.log(
        `Preparing Instagram ${postType} for Account ${igUserId}...`,
      );

      const videoCount = mediaFiles.filter((f) =>
        f.mimeType.startsWith('video/'),
      ).length;
      const imageCount = mediaFiles.filter((f) =>
        f.mimeType.startsWith('image/'),
      ).length;

      // ROUTE 1: REELS
      if (postType === 'REEL') {
        if (videoCount !== 1)
          throw new BadRequestException('Reels must contain exactly 1 video.');
        const file = mediaFiles[0];
        // Pass true for isVideo
        return this.publishMedia(
          igUserId,
          accessToken,
          content,
          file.url,
          'REELS',
          true,
          file.coverUrl,
        );
      }

      // ROUTE 2: STORIES
      if (postType === 'STORY') {
        if (mediaFiles.length !== 1)
          throw new BadRequestException('Stories must contain exactly 1 item.');
        const file = mediaFiles[0];
        const isVideo = file.mimeType.startsWith('video/');
        return this.publishMedia(
          igUserId,
          accessToken,
          '',
          file.url,
          'STORIES',
          isVideo,
          file.coverUrl,
        );
      }

      // ROUTE 3: FEED single items
      if (videoCount === 1 && mediaFiles.length === 1) {
        return this.publishMedia(
          igUserId,
          accessToken,
          content,
          mediaFiles[0].url,
          'REELS',
          true,
          mediaFiles[0].coverUrl,
        );
      }

      if (imageCount === 1 && mediaFiles.length === 1) {
        return this.publishMedia(
          igUserId,
          accessToken,
          content,
          mediaFiles[0].url,
          'IMAGE',
          false,
        );
      }

      // =========================================================
      // 📰 ROUTE 3: FEED (Standard)
      // =========================================================

      // A. Carousel (Album)
      if (mediaFiles.length > 1) {
        if (mediaFiles.length > 10)
          throw new BadRequestException(
            'Instagram allows max 10 items per carousel.',
          );
        return this.publishCarousel(igUserId, accessToken, content, mediaFiles);
      }
    } catch (error) {
      console.log(error);
      this.handleError(error);
    }
  }

  // ==================================================
  // SINGLE MEDIA (Image, Video, Reel, Story)
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
    coverUrl?: string,
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
      coverUrl, // 👈 Pass it down
    );

    // Step 2: Publish Container
    return this.publishContainer(igUserId, token, containerId);
  }

  // ==================================================
  // HELPER: Create Container (Staging)
  // ==================================================
  private async createContainer(
    igUserId: string,
    token: string,
    mediaUrl: string,
    targetType: 'IMAGE' | 'VIDEO' | 'REELS' | 'STORIES',
    isVideo: boolean,
    caption: string,
    isCarouselItem = false,
    coverUrl?: string,
  ): Promise<string> {
    try {
      const baseUrl = this.resolveHost(token);
      const url = `${baseUrl}/${igUserId}/media`;

      const body: any = {
        access_token: token,
      };

      if (!isCarouselItem && caption && caption.length > 0) {
        body.caption = caption;
      }

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
        // Standalone videos MUST be REELS.
        // Videos inside a Carousel MUST be VIDEO.
        body.media_type = isCarouselItem ? 'VIDEO' : 'REELS';
      } else {
        // For standard images, usually we don't send media_type,
        // or we send 'IMAGE' only if required by specific version.
        // v19.0+ infers it from image_url usually, but let's be explicit if needed.
        body.media_type = 'IMAGE';
      }

      // 3. Carousel Flag
      if (isCarouselItem) {
        body.is_carousel_item = true;
      }

      this.logger.log(
        `Creating IG Container (Target: ${targetType}, Video: ${isVideo})...`,
      );

      const response = await axios.post(url, body);

      const containerId = response.data.id;

      // 🛑 CRITICAL: Wait for Video Processing
      if (isVideo) {
        await this.waitForProcessing(containerId, token, 30, 5000); // 30 tries = 150s
      }

      return containerId;
    } catch (e: any) {
      console.error('IG Container Error Data:', e.response?.data?.error);
      throw e;
    }
  }

  // ==================================================
  // 🎠 CAROUSEL (Mixed Images/Videos)
  // ==================================================
  private async publishCarousel(
    igUserId: string,
    token: string,
    caption: string,
    files: { url: string; mimeType: string; coverUrl?: string }[],
  ) {
    // Step 1: Create a Container for EACH item (Children)
    // Note: Carousel children do NOT have captions. Only the parent does.
    const childIds: string[] = [];

    for (const file of files) {
      const type = file.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE';
      const isVideo = file.mimeType.startsWith('video/');
      const childId = await this.createContainer(
        igUserId,
        token,
        file.url,
        type,
        isVideo,
        '',
        true,
        file.coverUrl,
      ); // isCarouselItem=true
      childIds.push(childId);
    }

    for (const id of childIds) {
      // Poll status_code for each child; if any ERROR -> fail fast with details
      await this.waitForProcessing(id, token, 30, 5000);
    }

    // Step 2: Create the Parent Carousel Container
    this.logger.log(
      `Creating Carousel Parent with ${childIds.length} items...`,
    );

    const baseUrl = this.resolveHost(token);
    const url = `${baseUrl}/${igUserId}/media`;

    const response = await axios.post(url, {
      media_type: 'CAROUSEL',
      children: childIds, // Array of creation_ids
      caption: caption,
      access_token: token,
    });

    const parentContainerId = response.data.id;

    // 💡 Add a 3-second buffer.
    // Even if children are "FINISHED", the parent object often needs
    // a moment to stabilize before the /media_publish call works.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 3: Publish Parent
    return this.publishContainer(igUserId, token, parentContainerId);
  }

  // ==================================================
  // 🛠️ HELPER: Publish Container (The "Go Live" Step)
  // ==================================================
  private async publishContainer(
    igUserId: string,
    token: string,
    containerId: string,
  ) {
    const baseUrl = this.resolveHost(token);
    const publishUrl = `${baseUrl}/${igUserId}/media_publish`;

    // Optional: wait for container readiness (helps reduce 9007)
    await this.waitForProcessing(containerId, token, 30, 2000);

    // Try publishing with retries for "not ready yet" (code 9007)
    let lastErr: any;

    for (let i = 0; i < 10; i++) {
      try {
        const pub = await axios.post(publishUrl, {
          creation_id: containerId,
          access_token: token,
        });

        const mediaId = pub.data.id;

        const info = await axios.get(`${baseUrl}/${mediaId}`, {
          params: { fields: 'permalink', access_token: token },
        });

        return { platformPostId: mediaId, url: info.data.permalink };
      } catch (e: any) {
        lastErr = e;
        const err = e?.response?.data?.error;

        // Media not ready yet
        if (err?.code === 9007) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        // Any other error -> fail fast with the real message
        this.logger.error(
          `IG media_publish failed for container ${containerId}`,
          e?.response?.data,
        );
        throw new BadRequestException(
          `Instagram media_publish failed: ${err?.message ?? e.message}`,
        );
      }
    }

    // If we exhausted retries, surface the last error
    const err = lastErr?.response?.data?.error;
    this.logger.error(
      `IG media_publish still not ready after retries for container ${containerId}`,
      lastErr?.response?.data,
    );

    throw new BadRequestException(
      `Instagram media_publish failed: media still not ready after retries. ${err?.message ?? ''}`.trim(),
    );
  }

  // ==================================================
  // ⏳ HELPER: Wait for Status "FINISHED"
  // ==================================================
  private async waitForProcessing(
    containerId: string,
    token: string,
    maxAttempts = 30,
    delayMs = 5000,
  ) {
    let attempts = 0;
    const baseUrl = this.resolveHost(token);

    while (attempts < maxAttempts) {
      const url = `${baseUrl}/${containerId}`;
      const response = await axios.get(url, {
        params: { fields: 'status_code,status', access_token: token },
      });

      const status = response.data.status_code;

      if (status === 'FINISHED') return true;

      if (status === 'ERROR') {
        throw new InternalServerErrorException(
          `Instagram failed to process container ${containerId}: ${JSON.stringify(response.data)}`,
        );
      }

      this.logger.debug(`Container ${containerId} is ${status}. Waiting...`);
      await new Promise((r) => setTimeout(r, delayMs));
      attempts++;
    }

    throw new InternalServerErrorException(
      `Instagram processing timed out for container ${containerId}`,
    );
  }

  private handleError(error: any) {
    // Instagram provides deep error details here:
    const igError = error.response?.data?.error;
    this.logger.error('Instagram API Detail:', igError);

    const msg = igError?.message || error.message;
    throw new InternalServerErrorException(`Instagram Failed: ${msg}`);
  }

  private resolveHost(token: string): string {
    // Native Instagram tokens usually start with IGQV or IGQW
    if (token.trim().startsWith('IG')) {
      return 'https://graph.instagram.com/v23.0';
    }
    return 'https://graph.facebook.com/v23.0';
  }
}
