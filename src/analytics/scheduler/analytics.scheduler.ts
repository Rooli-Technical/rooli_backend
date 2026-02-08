import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@/prisma/prisma.service';
import { Platform, PlanTier } from '@generated/enums';

@Injectable()
export class AnalyticsScheduler {
  private readonly logger = new Logger(AnalyticsScheduler.name);
  private readonly BATCH_SIZE = 100;

  constructor(
    @InjectQueue('analytics-queue') private readonly analyticsQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 🕛 DAILY CRON JOB
   * Runs every day at midnight (00:00) to fetch fresh stats.
   * Customize via CronExpression if needed.
   */
  // @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async scheduleDailyFetch() {
    this.logger.log('⏰ Starting Daily Analytics Scheduling...');

    let cursor: string | undefined;
    let hasMore = true;
    let totalScheduled = 0;

    while (hasMore) {
      // 1. Fetch all ACTIVE social profiles
      // We only want profiles that are connected (accessToken exists)
      // and belong to active subscriptions.
      const profiles = await this.prisma.socialProfile.findMany({
        take: this.BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { id: 'asc' },
        where: {
          isActive: true,
          accessToken: { not: null },
          workspace: {
            organization: {
              isActive: true,
            },
          },
        },
        select: {
          id: true,
          platform: true,
          platformId: true,
          accessToken: true,
          workspace: {
            select: {
              id: true,
              timezone: true,
              organization: {
                select: {
                  subscription: {
                    select: {
                      plan: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (profiles.length === 0) {
        hasMore = false;
        break;
      }

      // 2. Process Batch
      const jobs = [];
      for (const profile of profiles) {
        try {
          const planTier =
            profile.workspace.organization.subscription.plan.tier;

            // Spread jobs over 60 minutes (3,600,000 milliseconds)
            const ONE_HOUR_MS = 60 * 60 * 1000;
            const delay = Math.floor(Math.random() * ONE_HOUR_MS);
            jobs.push({
              name: 'fetch-stats',
              data: { socialProfileId: profile.id },
              opts: {
                jobId: `analytics-${profile.id}-${new Date().toISOString().split('T')[0]}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: true,
                delay: delay,
              },
            });
        } catch (error: any) {
          this.logger.error(
            `Failed to schedule job for profile ${profile.id}: ${error.message}`,
            error.stack,
          );
          // Continue to next profile
        }
      }

      // 3. Bulk Add to Queue (Much faster than awaiting one by one)
      if (jobs.length > 0) {
        await this.analyticsQueue.addBulk(jobs);
        totalScheduled += jobs.length;
      }

      // 4. Update Cursor
      cursor = profiles[profiles.length - 1].id;

      // Safety break for empty batch
      if (profiles.length < this.BATCH_SIZE) {
        hasMore = false;
      }
    }

    this.logger.log(`✅ Finished scheduling. Total jobs: ${totalScheduled}`);
  }
  /**
   * Helper: Check if this plan allows this platform
   */
  // private shouldSkipPlatform(platform: Platform, plan: PlanTier): boolean {
  //   // Creator Plan does NOT include Twitter (X)
  //   if (plan === 'CREATOR' && platform === 'TWITTER') {
  //     return true; // Skip
  //   }
  //   return false;
  // }
}
