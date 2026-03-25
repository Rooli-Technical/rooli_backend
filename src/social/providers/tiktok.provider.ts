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

@Injectable()
export class TikTokProvider implements ISocialProvider {
  private readonly logger = new Logger(TikTokProvider.name);
  private readonly API_URL = 'https://open.tiktokapis.com/v2';
  private readonly BASE_URL = 'https://api.rooli.co/api/v1';

  async publish(
    credentials: SocialCredentials,
    content: string, // This is the caption
    mediaFiles: {
      url: string; // The URL of the video or image
      mimeType: string;
      sizeBytes?: number;
    }[],
    metadata?: { pageId: string; postType?: 'FEED' },
  ) {
    const accessToken = credentials.accessToken;
    this.logger.log(`Preparing TikTok Direct Post...`);

    const videoFiles = mediaFiles.filter((m) =>
      m.mimeType.startsWith('video/'),
    );
    const imageFiles = mediaFiles.filter((m) =>
      m.mimeType.startsWith('image/'),
    );

    try {
      // ==========================================
      // ROUTE A: PHOTO MODE (Carousel)
      // ==========================================
      if (imageFiles.length > 0) {
        // Extract just the URLs for the TikTok API
        const imageUrls = imageFiles.map((img) => img.url);
        return await this.publishPhotos(accessToken, content, imageUrls);
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

        // 1. Download video to buffer for chunking
        const videoBuffer = await this.downloadVideo(video.url);

        // 2. Initialize upload & pass the caption!
        const { uploadId, uploadUrl } = await this.initializeVideoUpload(
          accessToken,
          video.sizeBytes,
          content,
        );

        // 3. Upload chunks
        await this.uploadChunks(uploadUrl, videoBuffer, video.sizeBytes);

        // 4. Return formatted result
        return {
          platformPostId: uploadId,
          url: `https://www.tiktok.com/@tiktok`, // URL will be updated by your webhook later
        };
      }
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // ==================================================
  // 📸 PHOTO UPLOAD (Binary FILE_UPLOAD Method)
  // ==================================================
private async publishPhotos(
  accessToken: string,
  caption: string,
  imageUrls: string[],
) {
  this.logger.log(`Starting TikTok URL_PULL for ${imageUrls.length} image(s)...`);

  // STEP 1: Convert to proxy URLs
  const proxyUrls = this.buildProxyUrls(imageUrls);

  const url = `${this.API_URL}/post/publish/content/init/`;

  const sourceInfo: any = {
    source: 'PULL_FROM_URL',
    photo_images: proxyUrls,
  };

  if (proxyUrls.length > 1) {
    sourceInfo.photo_cover_index = 0;
  }

  const initBody = {
    post_info: {
      title: '',
      description: caption || '',
      privacy_level: 'SELF_ONLY',
      disable_comment: false,
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
  ) {
    this.logger.log(
      `Initializing TikTok video upload (Size: ${fileSizeBytes})...`,
    );

    const url = `${this.API_URL}/post/publish/video/init/`;

    // 1. Pre-calculate chunk logic
    const chunkSize = Math.min(fileSizeBytes, 10000000); // 10MB max per chunk
    const totalChunkCount = Math.ceil(fileSizeBytes / chunkSize);

    const body = {
      post_info: {
        title: caption || '', // 👈 Failsafe: ensures title is never 'undefined'
        //privacy_level: 'PUBLIC_TO_EVERYONE',
        privacy_level: 'SELF_ONLY',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
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
  return imageUrls.map((url) =>
    `${this.BASE_URL}/tiktok/media?url=${encodeURIComponent(url)}`,
  );
}

  private handleError(error: any) {
    const tqError = error.response?.data?.error;
    this.logger.error('TikTok API Error', tqError || error.message);
    const msg = tqError?.message || error.message;
    throw new InternalServerErrorException(`TikTok Failed: ${msg}`);
  }
}
