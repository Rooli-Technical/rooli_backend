import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwitterApi, TwitterApiReadWrite } from 'twitter-api-v2';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import { ISocialProvider, SocialCredentials } from '../interfaces/social-provider.interface';

@Injectable()
export class TwitterProvider implements ISocialProvider {
  private readonly logger = new Logger(TwitterProvider.name);

  constructor(private readonly configService: ConfigService) {}

  async publish(
    credentials: SocialCredentials,
    content: string,
    mediaFiles: { url: string; mimeType: string }[],
    metadata?: { replyToPostId?: string },
  ) {
    const client = new TwitterApi({
      appKey: this.configService.get<string>('TWITTER_API_KEY'),
      appSecret: this.configService.get<string>('TWITTER_API_SECRET'),
      accessToken: credentials.accessToken,
      accessSecret: credentials.refreshToken,
    });

    const rwClient = client.readWrite;

    try {
      const mediaIds: string[] = [];

      if (mediaFiles.length > 0) {
        this.logger.log(`Processing ${mediaFiles.length} media file(s) for Twitter`);

        // Sequential is best for temporary file handling
        for (const file of mediaFiles) {
          const mediaId = await this.uploadMediaViaTempFile(
            rwClient,
            file.url,
            file.mimeType,
          );
          mediaIds.push(mediaId);
        }
      }

      const payload: any = { text: content };

      if (mediaIds.length > 0) {
        payload.media = { media_ids: mediaIds };
      }

      if (metadata?.replyToPostId) {
        payload.reply = {
          in_reply_to_tweet_id: metadata.replyToPostId,
        };
      }

      this.logger.log('Publishing tweet...');
      const response = await rwClient.v2.tweet(payload);

      return {
        platformPostId: response.data.id,
        url: `https://twitter.com/user/status/${response.data.id}`,
      };
    } catch (error) {
      this.logger.error('Twitter publish failed', error);
      const message =
        error?.data?.detail ||
        error?.message ||
        'Unknown Twitter error';
      throw new InternalServerErrorException(`Twitter Error: ${message}`);
    }
  }

  // ==================================================
  // 📸 STREAM-TO-DISK -> UPLOAD -> CLEANUP
  // ==================================================
  private async uploadMediaViaTempFile(
    client: TwitterApiReadWrite,
    url: string,
    mimeType: string,
  ): Promise<string> {
    // 1. Create a Temp File Path
    const tmpDir = os.tmpdir();
    const ext = this.getExtension(mimeType);
    const tempFilePath = path.join(tmpDir, `rooli-upload-${randomUUID()}.${ext}`);

    try {
      this.logger.log(`Streaming to temp file: ${tempFilePath}`);

      // 2. Download Stream -> Disk
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 30_000,
      });

      // Pipeline handles backpressure and error propagation automatically
      await pipeline(response.data, fs.createWriteStream(tempFilePath));

      // 3. Determine Category (Required for v1.1 upload)
      // Note: The library uses 'type', NOT 'media_category' in the options object
      let type: 'tweet_video' | 'tweet_gif' | 'tweet_image' = 'tweet_image';

      if (mimeType.startsWith('video/')) {
        type = 'tweet_video';
      } else if (mimeType === 'image/gif') {
        type = 'tweet_gif';
      }

      this.logger.log(`Uploading from disk to Twitter (type=${type})`);

      // 4. Upload from Disk
      // The library is happy because it gets a file path. 
      // It handles reading the file size and chunking automatically.
      const mediaId = await client.v1.uploadMedia(tempFilePath, {
        mimeType,
        type, 
        target: 'tweet',
      });

      return mediaId;

    } catch (error) {
      this.logger.error(`Media upload failed: ${url}`, error);
      throw error;
    } finally {
      // 5. Cleanup: Always delete the temp file
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          this.logger.debug(`Cleaned up temp file: ${tempFilePath}`);
        }
      } catch (cleanupError) {
        this.logger.warn(`Failed to cleanup temp file: ${tempFilePath}`, cleanupError);
      }
    }
  }

  private getExtension(mimeType: string): string {
    const map = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
    };
    return map[mimeType] || 'bin';
  }
}
