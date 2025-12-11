import { PrismaService } from "@/prisma/prisma.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Queue } from "bullmq";

@Injectable()
export class AnalyticsSchedulerService {
  private readonly logger = new Logger(AnalyticsSchedulerService.name);
  private readonly BATCH_SIZE = 100;

  constructor(
    private prisma: PrismaService,
    @InjectQueue('analytics-queue') private analyticsQueue: Queue,
  ) {}

  // Run every 5 minutes
 // @Cron('*/5 * * * *')
  async schedulePostUpdates() {
    this.logger.log('🕵️ Checking for posts due for analytics...');

    // 1. Find posts where nextAnalyticsCheck <= NOW
    const postsDue = await this.prisma.post.findMany({
      where: {
        status: 'PUBLISHED',
        nextAnalyticsCheck: { lte: new Date() },
        platformPostId: { not: null },
      },
      take: this.BATCH_SIZE,
      select: { id: true, platform: true }, // Select minimal data
      orderBy: { nextAnalyticsCheck: 'asc' },
    });

    if (postsDue.length === 0) return;

    // Add to BullMQ
    // We create a "Job" for each post
    const jobs = postsDue.map((post) => ({
      name: 'sync-post-metrics',
      data: { postId: post.id }, // Payload is just the ID
    }));

    await this.analyticsQueue.addBulk(jobs);

    this.logger.log(`🚀 Queued ${postsDue.length} posts for updates.`);
  }
}