import { Prisma } from '@generated/client';
import { Injectable, Logger } from '@nestjs/common';
import {
  AccountMetrics,
  PostMetrics,
} from '../interfaces/analytics-provider.interface';
import { AnalyticsRepository } from './analytics.repository';

@Injectable()
export class AnalyticsNormalizerService {
  private readonly logger = new Logger(AnalyticsNormalizerService.name);

  constructor(private readonly analyticsRepository: AnalyticsRepository) {}

  /**
   * Step 1: Calculate "Growth" (Today - Yesterday)
   * Prepares the payload for the 'AccountAnalytics' table.
   */
  async normalizeAccountStats(
    internalSocialProfileId: string,
    rawData: AccountMetrics,
  ): Promise<Prisma.AccountAnalyticsUncheckedCreateInput> {
    // Get the LAST snapshot to compare against
    const previousSnapshot =
      await this.analyticsRepository.getLastAccountSnapshot(
        internalSocialProfileId,
      );

    // Calculate Growth
    const growth = this.calculateDelta(
      rawData.followersCount,
      previousSnapshot?.followersTotal,
    );

    // Return DB Object
    return {
      socialProfileId: internalSocialProfileId,
      date: new Date(),
      followersTotal: rawData.followersCount,
      followersGained: growth.gained,
      followersLost: growth.lost,
      reach: rawData.reach,
      engagementCount: rawData.engagementCount || 0,
      clicks: rawData.clicks || 0,
      demographics: rawData.demographics || Prisma.JsonNull,
      impressions: rawData.impressionsCount || 0,
      profileViews: rawData?.profileViews || 0

    };
  }

  /**
   * Step 2: Prepare Post Snapshot
   * Prepares payload for 'PostAnalyticsSnapshot' table.
   * NOTE: We store CUMULATIVE totals. We do NOT subtract yesterday's likes here.
   * This ensures data integrity. Subtracting happens at Read-Time (Dashboard).
   */
  normalizePostStats(
    internalPostDestinationId: string, // The UUID of the post in your DB
    rawData: PostMetrics,
  ): Prisma.PostAnalyticsSnapshotUncheckedCreateInput {
    return {
      postDestinationId: internalPostDestinationId,
      day: new Date(), // Today

      // -- Standard Metrics --
      likes: rawData.likes,
      comments: rawData.comments,
      shares: rawData.shares,
      impressions: rawData.impressions,

      // -- Advanced Metrics --
      reach: rawData.reach || 0,
      clicks: rawData.clicks || 0,
      saves: rawData.saves || 0, 
      videoViews: rawData.videoViews || 0,

      // -- Debugging --
      // Store the raw dump in case we missed a metric and need to backfill later
      metadata: rawData as unknown as Prisma.InputJsonValue,
    };
  }

  /**
   * Helper: Calculates the difference between two numbers safely.
   */
  private calculateDelta(current: number, previous?: number | null) {
    // If no previous history (first fetch), we assume 0 growth to avoid massive spikes.
    // Or you can set 'gained' to 0.
    if (previous === undefined || previous === null) {
      return { gained: 0, lost: 0 };
    }

    const diff = current - previous;

    return {
      gained: diff > 0 ? diff : 0,
      lost: diff < 0 ? Math.abs(diff) : 0,
    };
  }
}
