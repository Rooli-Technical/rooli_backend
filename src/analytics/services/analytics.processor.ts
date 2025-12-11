import { PrismaService } from '@/prisma/prisma.service';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AnalyticsWorkerService } from './analytics.worker';

@Processor('analytics-queue', {
  concurrency: 5,
  limiter: {
    max: 20, // Max 20 jobs...
    duration: 1000, // ...per 1 second
  },
}) // Run 5 jobs at once
export class AnalyticsProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsProcessor.name);

  constructor(
    private prisma: PrismaService,
    private workerService: AnalyticsWorkerService,
  ) {
    super();
  }

  async process(job: Job<{ postId: string }>): Promise<any> {
    const { postId } = job.data;

    // 1. Fetch full post details (Token, IDs, etc)
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: { pageAccount: true, socialAccount: true },
    });

    if (!post) return;

    this.logger.debug(`Processing analytics for Post: ${post.id}`);

    try {
      // 2. Call your actual logic (The API calls)
      await this.workerService.syncPost(post);

      // 3. SUCCESS: Calculate Next Fetch Time (Decay Algorithm)
      await this.scheduleNextFetch(post);
    } catch (error) {
      this.logger.error(`Failed to sync post ${postId}`, error);

      // If it's a Rate Limit error, we can throw so BullMQ retries later
      // Or we can manually reschedule logic here.
      throw error;
    }
  }

  // The "Decay" Logic - moves to the processor so it only updates ON SUCCESS
  private async scheduleNextFetch(post: any) {
    const now = new Date();
    const publishedAt = new Date(post.publishedAt);
    const ageInHours =
      (now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60);

    let nextCheckInMinutes = 60; // Default

    // Buffer/Hootsuite Logic:
    if (ageInHours < 24)
      nextCheckInMinutes = 60; // Every 1h
    else if (ageInHours < 168)
      nextCheckInMinutes = 360; // Every 6h (7 days)
    else if (ageInHours < 720)
      nextCheckInMinutes = 1440; // Every 24h (30 days)
    else nextCheckInMinutes = 10080; // Weekly (Forever)

    const nextDate = new Date(now.getTime() + nextCheckInMinutes * 60000);

    await this.prisma.post.update({
      where: { id: post.id },
      data: {
        lastAnalyticsCheck: now,
        nextAnalyticsCheck: nextDate,
      },
    });
  }
}
