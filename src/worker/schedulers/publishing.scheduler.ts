import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@/prisma/prisma.service';


//This service runs automatically every minute. Its only job is to move posts from the Database to the Queue.

@Injectable()
export class PublishingScheduler {
  private readonly logger = new Logger(PublishingScheduler.name);

  constructor(
    private prisma: PrismaService,
    @InjectQueue('publishing-queue') private publishingQueue: Queue,
  ) {}

  // Runs every minute (at :00 seconds)
  //@Cron(CronExpression.EVERY_MINUTE)
  async handleScheduledPosts() {
    
    // 1. Find "Due" Posts
    // Criteria: Status is SCHEDULED AND Time is in the past (or now)
    const now = new Date();
    
    const duePosts = await this.prisma.post.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { lte: now }, // Less than or equal to Now
        parentPostId: null,
      },
      select: { id: true },
      take: 50, // Process in batches to avoid RAM spikes
    });

    if (duePosts.length === 0) return;

    this.logger.log(`Found ${duePosts.length} posts due for publishing.`);

    // 2. The "Lock" Mechanism 
    // Immediately mark them as 'PUBLISHING' so the next Cron job (in 1 min)
    // doesn't pick them up again.
    await this.prisma.post.updateMany({
      where: { id: { in: duePosts.map((p) => p.id) } },
      data: { status: 'PUBLISHING' },
    });

    // 3. Push to Redis Queue
    // We add them to the queue to be processed by the worker
    const jobs = duePosts.map((post) => ({
      name: 'publish-post',
      data: { postId: post.id },
      opts: { 
        attempts: 3, // Retry 3 times on crash
        backoff: 5000 // Wait 5s between retries
      }
    }));

    await this.publishingQueue.addBulk(jobs);
  }
}