import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import {
  ISocialProvider,
  SocialCredentials,
} from '../interfaces/social-provider.interface';

type TikTokPrivacyLevel =
  | 'PUBLIC_TO_EVERYONE'
  | 'MUTUAL_FOLLOW_FRIENDS'
  | 'FOLLOWER_OF_CREATOR'
  | 'SELF_ONLY';

export interface TikTokPostOptions {
  privacyLevel?: TikTokPrivacyLevel;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  videoCoverTimestampMs?: number;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
}

interface CreatorInfo {
  privacyLevelOptions: TikTokPrivacyLevel[];
  maxVideoPostDurationSec: number;
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
}

@Injectable()
export class TikTokProvider implements ISocialProvider {
  private readonly logger = new Logger(TikTokProvider.name);
  private readonly API_URL = 'https://open.tiktokapis.com/v2';
  private readonly BASE_URL = 'https://api.rooli.co/api/v1';

  async publish(
    credentials: SocialCredentials,
    content: string, // This is the caption
    mediaFiles: {
      url: string;
      mimeType: string;
      sizeBytes?: number;
      durationSeconds?: number;
    }[],
    metadata?: {
      pageId: string;
      postType?: 'FEED';
      tiktok?: TikTokPostOptions;
    },
  ) {
    const accessToken = credentials.accessToken;
    const options = metadata?.tiktok ?? {};
    this.logger.log(`Preparing TikTok Direct Post...`);

    const videoFiles = mediaFiles.filter((m) =>
      m.mimeType.startsWith('video/'),
    );
    const imageFiles = mediaFiles.filter((m) =>
      m.mimeType.startsWith('image/'),
    );

    try {
      // Pre-flight: fetch creator capabilities so we can validate user choices
      // and surface clean errors instead of letting TikTok reject late.
      const creatorInfo = await this.getCreatorInfo(accessToken);

      // ==========================================
      // ROUTE A: PHOTO MODE (Carousel)
      // ==========================================
      if (imageFiles.length > 0) {
        const imageUrls = imageFiles.map((img) => img.url);
        return await this.publishPhotos(
          accessToken,
          content,
          imageUrls,
          creatorInfo,
          options,
        );
      }

      // ==========================================
      // ROUTE B: VIDEO POST (Chunked Upload)
      // ==========================================
      if (videoFiles.length > 0) {
        const video = videoFiles[0];

        if (!video.sizeBytes) {
          throw new InternalServerErrorException(
            'Missing video size. TikTok requires the exact file size to initialize uploads.',
          );
        }

        if (
          video.durationSeconds &&
          creatorInfo.maxVideoPostDurationSec > 0 &&
          video.durationSeconds > creatorInfo.maxVideoPostDurationSec
        ) {
          throw new BadRequestException(
            `Video is ${video.durationSeconds}s but this TikTok creator can only post videos up to ${creatorInfo.maxVideoPostDurationSec}s.`,
          );
        }

        const videoBuffer = await this.downloadVideo(video.url);

        const { uploadId, uploadUrl } = await this.initializeVideoUpload(
          accessToken,
          video.sizeBytes,
          content,
          creatorInfo,
          options,
        );

        await this.uploadChunks(uploadUrl, videoBuffer, video.sizeBytes);

        return {
          platformPostId: uploadId,
          url: `https://www.tiktok.com/@tiktok`, // resolved later by webhook
        };
      }
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      this.handleError(error);
    }
  }

  // ==================================================
  // 🔍 CREATOR INFO QUERY (pre-flight validation)
  // ==================================================
  private async getCreatorInfo(accessToken: string): Promise<CreatorInfo> {
    const url = `${this.API_URL}/post/publish/creator_info/query/`;

    const response = await axios.post(
      url,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
      },
    );

    const data = response.data;
    if (data.error?.code !== 'ok' && data.error?.code !== 0) {
      throw new InternalServerErrorException(
        `Failed to fetch TikTok creator info: ${data.error?.message}`,
      );
    }

    const d = data.data ?? {};
    return {
      privacyLevelOptions: d.privacy_level_options ?? [],
      maxVideoPostDurationSec: d.max_video_post_duration_sec ?? 0,
      commentDisabled: !!d.comment_disabled,
      duetDisabled: !!d.duet_disabled,
      stitchDisabled: !!d.stitch_disabled,
    };
  }

  private resolvePrivacyLevel(
    requested: TikTokPrivacyLevel | undefined,
    info: CreatorInfo,
    mediaType: 'PHOTO' | 'VIDEO',
  ): TikTokPrivacyLevel {
    // TikTok does not support FOLLOWER_OF_CREATOR for photo carousels.
    const allowed =
      mediaType === 'PHOTO'
        ? info.privacyLevelOptions.filter((p) => p !== 'FOLLOWER_OF_CREATOR')
        : info.privacyLevelOptions;

    if (allowed.length === 0) {
      throw new BadRequestException(
        'This TikTok creator has no available privacy options. The account may be restricted.',
      );
    }

    if (requested) {
      if (!allowed.includes(requested)) {
        throw new BadRequestException(
          `Privacy level "${requested}" is not allowed for this TikTok creator. Allowed: ${allowed.join(', ')}.`,
        );
      }
      return requested;
    }

    const preferenceOrder: TikTokPrivacyLevel[] = [
      'PUBLIC_TO_EVERYONE',
      'FOLLOWER_OF_CREATOR',
      'MUTUAL_FOLLOW_FRIENDS',
      'SELF_ONLY',
    ];
    return preferenceOrder.find((p) => allowed.includes(p)) ?? allowed[0];
  }

  // ==================================================
  // 📸 PHOTO UPLOAD (PULL_FROM_URL)
  // ==================================================
  private async publishPhotos(
    accessToken: string,
    caption: string,
    imageUrls: string[],
    creatorInfo: CreatorInfo,
    options: TikTokPostOptions,
  ) {
    this.logger.log(
      `Starting TikTok URL_PULL for ${imageUrls.length} image(s)...`,
    );

    const proxyUrls = this.buildProxyUrls(imageUrls);

    const url = `${this.API_URL}/post/publish/content/init/`;

    const sourceInfo: any = {
      source: 'PULL_FROM_URL',
      photo_images: proxyUrls,
    };

    if (proxyUrls.length > 1) {
      sourceInfo.photo_cover_index = 0;
    }

    const privacyLevel = this.resolvePrivacyLevel(
      options.privacyLevel,
      creatorInfo,
      'PHOTO',
    );

    // If the creator has globally disabled comments, the post must mirror that.
    const disableComment =
      creatorInfo.commentDisabled || !!options.disableComment;

    const initBody = {
      post_info: {
        title: '',
        description: caption || '',
        privacy_level: privacyLevel,
        disable_comment: disableComment,
        ...(options.brandContentToggle !== undefined && {
          brand_content_toggle: options.brandContentToggle,
        }),
        ...(options.brandOrganicToggle !== undefined && {
          brand_organic_toggle: options.brandOrganicToggle,
        }),
      },
      source_info: sourceInfo,
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
    };

    const initResponse = await axios.post(url, initBody, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const initData = initResponse.data;

    if (initData.error?.code !== 'ok' && initData.error?.code !== 0) {
      throw new InternalServerErrorException(
        `Photo Init Failed: ${initData.error?.message}`,
      );
    }

    this.logger.log(`TikTok is now pulling images from your proxy...`);

    return {
      platformPostId: initData.data.publish_id,
      url: `https://www.tiktok.com/@tiktok`,
    };
  }

  // ==================================================
  // 🎬 VIDEO UPLOAD (Step 1: Init)
  // ==================================================
  private async initializeVideoUpload(
    accessToken: string,
    fileSizeBytes: number,
    caption: string,
    creatorInfo: CreatorInfo,
    options: TikTokPostOptions,
  ) {
    this.logger.log(
      `Initializing TikTok video upload (Size: ${fileSizeBytes})...`,
    );

    const url = `${this.API_URL}/post/publish/video/init/`;

    const chunkSize = Math.min(fileSizeBytes, 10000000); // 10MB max per chunk
    const totalChunkCount = Math.ceil(fileSizeBytes / chunkSize);

    const privacyLevel = this.resolvePrivacyLevel(
      options.privacyLevel,
      creatorInfo,
      'VIDEO',
    );

    // Mirror creator-level interaction toggles when they're globally disabled.
    const disableComment =
      creatorInfo.commentDisabled || !!options.disableComment;
    const disableDuet = creatorInfo.duetDisabled || !!options.disableDuet;
    const disableStitch = creatorInfo.stitchDisabled || !!options.disableStitch;

    const body = {
      post_info: {
        title: caption || '',
        privacy_level: privacyLevel,
        disable_comment: disableComment,
        disable_duet: disableDuet,
        disable_stitch: disableStitch,
        ...(options.videoCoverTimestampMs !== undefined && {
          video_cover_timestamp_ms: options.videoCoverTimestampMs,
        }),
        ...(options.brandContentToggle !== undefined && {
          brand_content_toggle: options.brandContentToggle,
        }),
        ...(options.brandOrganicToggle !== undefined && {
          brand_organic_toggle: options.brandOrganicToggle,
        }),
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: fileSizeBytes,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    };

    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const data = response.data;
    if (data.error?.code !== 'ok' && data.error?.code !== 0) {
      throw new InternalServerErrorException(
        `Video Init Upload Failed: ${data.error?.message}`,
      );
    }

    return {
      uploadId: data.data.publish_id,
      uploadUrl: data.data.upload_url,
    };
  }

  // ==================================================
  // 🎬 VIDEO UPLOAD (Step 2: Chunks)
  // ==================================================
  private async uploadChunks(
    uploadUrl: string,
    buffer: Buffer,
    totalSize: number,
  ) {
    this.logger.log(`Uploading video chunks to TikTok...`);

    const chunkSize = Math.min(totalSize, 10000000);
    let start = 0;
    let end = chunkSize;

    while (start < totalSize) {
      const chunk = buffer.subarray(start, end);

      this.logger.debug(`Uploading bytes ${start}-${end - 1} of ${totalSize}`);

      await axios.put(uploadUrl, chunk, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
        },
        maxBodyLength: Infinity,
      });

      start = end;
      end = Math.min(start + chunkSize, totalSize);
    }

    this.logger.log('All video chunks uploaded successfully.');
  }

  // ==================================================
  // UNSUPPORTED ACTIONS
  // ==================================================
  async editContent(accessToken: string, id: string, newContent: string) {
    throw new BadRequestException(
      'TikTok API does not support editing captions.',
    );
  }

  async deleteContent(accessToken: string, id: string) {
    throw new BadRequestException(
      'TikTok API does not support deleting posts.',
    );
  }

  // ==================================================
  // HELPERS
  // ==================================================
  private async downloadVideo(url: string): Promise<Buffer> {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }

  private buildProxyUrls(imageUrls: string[]) {
    return imageUrls.map(
      (url) => `${this.BASE_URL}/tiktok/media?url=${encodeURIComponent(url)}`,
    );
  }

  private handleError(error: any) {
    const tqError = error.response?.data?.error;
    this.logger.error('TikTok API Error', tqError || error.message);
    const msg = tqError?.message || error.message;
    throw new InternalServerErrorException(`TikTok Failed: ${msg}`);
  }
}
