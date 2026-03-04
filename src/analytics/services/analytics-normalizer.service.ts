import { Platform, Prisma } from '@generated/client';
import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';
import { FetchAccountResult, FetchPostResult } from '../interfaces/analytics-provider.interface';

@Injectable()
export class AnalyticsNormalizerService {
  private readonly logger = new Logger(AnalyticsNormalizerService.name);

  constructor(private readonly analyticsRepository: AnalyticsRepository) {}

  /**
   * Calculate "Growth" and separate the unified vs platform-specific payloads.
   */
  async normalizeAccountStats(
    internalSocialProfileId: string,
    platform: Platform,
    rawData: FetchAccountResult,
  ) {
    const previousSnapshot = await this.analyticsRepository.getLastAccountSnapshot(
      internalSocialProfileId,
    );

    const growth = this.calculateDelta(
      rawData.unified.followersTotal,
      previousSnapshot?.followersTotal,
    );

    const baseData = {
      socialProfileId: internalSocialProfileId,
      date: new Date(),
      followersTotal: rawData.unified.followersTotal,
      followersGained: growth.gained,
      followersLost: growth.lost,
      reach: rawData.unified.reach,
      engagementCount: rawData.unified.engagementCount,
      clicks: rawData.unified.clicks,
      impressions: rawData.unified.impressions,
      profileViews: rawData.unified.profileViews,
    };

    return {
      baseData,
      specificKey: this.getPlatformRelationKey(platform),
      specificData: rawData.specific,
    };
  }

  /**
   * Prepare Post Snapshot with nested relation key.
   */
  normalizePostStats(
    internalPostDestinationId: string,
    platform: Platform,
    rawData: FetchPostResult,
  ) {
    const baseData = {
      postDestinationId: internalPostDestinationId,
      day: new Date(),
      likes: rawData.unified.likes,
      comments: rawData.unified.comments,
      impressions: rawData.unified.impressions,
      reach: rawData.unified.reach,
      engagementCount: rawData.unified.engagementCount,
    };

    return {
      baseData,
      specificKey: this.getPlatformRelationKey(platform),
      specificData: rawData.specific,
    };
  }

  private calculateDelta(current: number, previous?: number | null) {
    if (previous === undefined || previous === null) {
      return { gained: 0, lost: 0 };
    }
    const diff = current - previous;
    return {
      gained: diff > 0 ? diff : 0,
      lost: diff < 0 ? Math.abs(diff) : 0,
    };
  }

  /**
   * Maps your Platform enum to the exact relation keys in your Prisma Schema
   */
  private getPlatformRelationKey(platform: Platform): string {
    switch (platform) {
      case 'TWITTER': return 'twitterStats';
      case 'LINKEDIN': return 'linkedInStats';
      case 'FACEBOOK': return 'facebookStats';
      case 'INSTAGRAM': return 'instagramStats';
      default: throw new Error(`Unsupported platform: ${platform}`);
    }
  }
}
