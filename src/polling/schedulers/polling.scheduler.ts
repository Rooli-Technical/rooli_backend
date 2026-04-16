import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@/prisma/prisma.service';
import { ConnectionStatus, Platform } from '@generated/enums';

@Injectable()
export class InboxSyncScheduler {
  private readonly logger = new Logger(InboxSyncScheduler.name);
  private readonly BATCH_SIZE = 100;

  constructor(
    @InjectQueue('inbox-sync') private readonly inboxSyncQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Runs every 15 minutes to poll platforms that don't support webhooks
   * (or as a fallback for missed webhooks).
   */
  // @Cron('0 */15 * * * *')
  //@Cron(CronExpression.EVERY_MINUTE) //every one minute
  async scheduleInboxSync() {
    this.logger.log('⏰ Starting 15-minute Inbox Sync Scheduler...');

    let cursor: string | undefined;
    let hasMore = true;
    let totalScheduled = 0;

    const currentMinuteBucket = Math.floor(Date.now() / 60000).toString();

    while (hasMore) {
      // 1. Fetch active profiles with connected accounts
      const profiles = await this.prisma.socialProfile.findMany({
        take: this.BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { id: 'asc' },
        where: {
          isActive: true,
          status: ConnectionStatus.CONNECTED,
          accessToken: { not: null },
          platform: 'LINKEDIN',
          // Only sync workspaces that have an active subscription
          workspace: { organization: { isActive: true } },
        },
        select: { id: true, platform: true },
      });

      this.logger.log('profiles', JSON.stringify(profiles));

      if (profiles.length === 0) {
        hasMore = false;
        break;
      }

      const cronRunId = new Date().toISOString().slice(0, 16);

      // 2. Prepare the batch of jobs
      const jobs = profiles.map((profile) => {
        // JITTER: Spread the jobs randomly over a 10-minute window (600,000 ms).
        // If you have 500 users, they won't all hit LinkedIn at 12:00:00.
        // Some will hit at 12:02, some at 12:08. This saves your API rate limits!
        const delay = Math.floor(Math.random() * 45000);

        return {
          name: `sync-${profile.platform.toLowerCase()}`,
          data: { profileId: profile.id, platform: profile.platform },
          opts: {
            // Using a specific JobID prevents queuing the exact same sync twice
            jobId: `inbox-sync-${profile.id}-${currentMinuteBucket}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            delay: delay,
          },
        };
      });

      // 3. Bulk Add to BullMQ (Much faster than individual adds)
      if (jobs.length > 0) {
        await this.inboxSyncQueue.addBulk(jobs);
        totalScheduled += jobs.length;
      }

      cursor = profiles[profiles.length - 1].id;
      if (profiles.length < this.BATCH_SIZE) hasMore = false;
    }

    this.logger.log(
      `✅ Finished Inbox Scheduling. Total profiles queued: ${totalScheduled}`,
    );
  }
}
