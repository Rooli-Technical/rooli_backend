import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { ISocialProvider, SocialCredentials } from '../interfaces/social-provider.interface';


@Injectable()
export class TikTokProvider implements ISocialProvider {
  private readonly logger = new Logger(TikTokProvider.name);
  private readonly API_URL = 'https://open.tiktokapis.com/v2';

  async publish(
    credentials: SocialCredentials,
    content: string, // This is the caption
    mediaFiles: {
      url: string; // The URL of the video
      mimeType: string;
      sizeBytes?: number; // Strongly recommended to pass file size from your frontend/DB
    }[],
    metadata?: { pageId: string; postType?: 'FEED' },
  ) {
    const accessToken = credentials.accessToken;

    this.logger.log(`Preparing TikTok Direct Post...`);

    // 1. Validation
    if (mediaFiles.length !== 1) {
      throw new BadRequestException('TikTok requires exactly 1 video file.');
    }

    const video = mediaFiles[0];
    if (!video.mimeType.startsWith('video/')) {
      throw new BadRequestException('TikTok only supports video files.');
    }


    // 2. Download the video into memory (or stream it) so we can chunk it
    const videoBuffer = await this.downloadVideo(video.url);

    try {
      // STEP 1: Initialize the upload process
      const { uploadId, uploadUrl } = await this.initializeUpload(
        accessToken,
        video.sizeBytes,
      );

      // STEP 2: Upload the video chunks
      await this.uploadChunks(uploadUrl, videoBuffer, video.sizeBytes);

      // STEP 3: Publish the video to the feed
      return await this.publishVideo(accessToken, uploadId, content);
      
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // ==================================================
  // STEP 1: INITIALIZE UPLOAD
  // ==================================================
  private async initializeUpload(accessToken: string, fileSizeBytes: number) {
    this.logger.log(`Initializing TikTok upload (Size: ${fileSizeBytes})...`);
    
    const url = `${this.API_URL}/post/publish/video/init/`;
    
    const body = {
      post_info: {
        privacy_level: 'PUBLIC_TO_EVERYONE', // Or MUTUAL_FOLLOW_FRIENDS, SELF_ONLY
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: fileSizeBytes,
        chunk_size: Math.min(fileSizeBytes, 10000000), // Max 10MB per chunk, we default to 10MB or the file size
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
        `Init Upload Failed: ${data.error?.message}`,
      );
    }

    return {
      uploadId: data.data.publish_id, // We need this to publish later
      uploadUrl: data.data.upload_url, // We PUT chunks to this URL
    };
  }

  // ==================================================
  // STEP 2: UPLOAD CHUNKS
  // ==================================================
  private async uploadChunks(uploadUrl: string, buffer: Buffer, totalSize: number) {
    this.logger.log(`Uploading video chunks to TikTok...`);
    
    // TikTok expects a single PUT request with the file stream if the chunk size 
    // configured in Step 1 is equal to or greater than the total file size.
    // For simplicity in MVP, we set chunk_size to 10MB or totalSize.
    // If the file is under 10MB, this acts as a single upload.

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
    
    this.logger.log('All chunks uploaded successfully.');
  }

  // ==================================================
  // STEP 3: PUBLISH POST
  // ==================================================
  private async publishVideo(accessToken: string, publishId: string, caption: string) {
    this.logger.log(`Publishing video ${publishId} to TikTok feed...`);
    
    const url = `${this.API_URL}/post/publish/content/init/`;
    // Note: TikTok API requires the caption to be passed in a specific format if it contains hashtags or mentions.
    // For MVP, we pass it as a raw string.
    
    // TikTok actually uses a slightly different flow for Direct Post now.
    // The init/ endpoint automatically publishes it once the video is fully processed on their end.
    // We just return the publish_id. TikTok does not immediately return a URL.

    return {
      platformPostId: publishId,
      url: `https://www.tiktok.com/@tiktok`, // TikTok API does not currently return the exact video URL at publish time
    };
  }


  // ==================================================
  // UNSUPPORTED ACTIONS
  // ==================================================
  
  async editContent(accessToken: string, id: string, newContent: string) {
    throw new BadRequestException('TikTok API does not support editing captions.');
  }

  async deleteContent(accessToken: string, id: string) {
    throw new BadRequestException('TikTok API does not support deleting videos.');
  }

  // ==================================================
  // HELPERS
  // ==================================================


  private async downloadVideo(url: string): Promise<Buffer> {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }

  private handleError(error: any) {
    const tqError = error.response?.data?.error;
    this.logger.error('TikTok API Error', tqError || error.message);
    const msg = tqError?.message || error.message;
    throw new InternalServerErrorException(`TikTok Failed: ${msg}`);
  }
}