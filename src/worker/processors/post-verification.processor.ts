import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

@Processor('post-verification')
export class PostVerificationProcessor extends WorkerHost {
  private readonly logger = new Logger(PostVerificationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
  ) {
    super(); // Required when extending WorkerHost
  }

  // This is the main entry point for BullMQ
  async process(job: Job<any, any, string>): Promise<any> {
    switch (job.name) {
      case 'fetch-real-post-id':
        return this.handleFetchRealPostId(job);
      
      // Add other job types for this queue here
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  private async handleFetchRealPostId(job: Job) {
    const { platform, mediaId, pageId, accessToken } = job.data;
    this.logger.log(`Checking Meta for real post_id for video ${mediaId}...`);

    try {
      const videoNodeUrl = `https://graph.facebook.com/v23.0/${mediaId}`;
      
      const response = await lastValueFrom(
        this.httpService.get(videoNodeUrl, {
          params: { fields: 'post_id', access_token: accessToken },
        }),
      );

      if (response.data.post_id) {
        const realPostId = `${pageId}_${response.data.post_id}`;

        await this.prisma.postDestination.updateMany({
          where: { platformPostId: mediaId },
          data: { platformPostId: realPostId },
        });

        this.logger.log(`✅ Success: Swapped ${mediaId} for ${realPostId}`);
        return { success: true };
      } else {
        throw new Error('Video still processing, post_id not available yet.');
      }
    } catch (error: any) {
      const msg = error.response?.data?.error?.message || error.message;
      this.logger.error(`Failed to fetch post_id for ${mediaId}: ${msg}`);
      throw error; 
    }
  }
}