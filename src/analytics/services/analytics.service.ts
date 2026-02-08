import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountMetrics,
  AuthCredentials,
  IAnalyticsProvider,
  PostMetrics,
} from '../interfaces/analytics-provider.interface';
import { FacebookAnalyticsProvider } from '../providers/facebook-analytics.provider';
import { InstagramAnalyticsProvider } from '../providers/instagram-analytics.provider';
import { LinkedInAnalyticsProvider } from '../providers/linkedin.provider';
import { TwitterAnalyticsProvider } from '../providers/twitter.provider';
import { PlanTier, Platform } from '@generated/enums';
import { PrismaService } from '@/prisma/prisma.service';
import { EncryptionService } from '@/common/utility/encryption.service';
import { AnalyticsRepository } from './analytics.repository';
import { endOfDay } from 'date-fns/endOfDay';
import { startOfDay } from 'date-fns/startOfDay';
import { subDays } from 'date-fns/subDays';
import { Prisma } from '@generated/client';
import { differenceInDays } from 'date-fns/differenceInDays';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private providers: Map<Platform, IAnalyticsProvider>;

  constructor(
    private readonly linkedInProvider: LinkedInAnalyticsProvider,
    private readonly twitterProvider: TwitterAnalyticsProvider,
    private readonly facebookProvider: FacebookAnalyticsProvider,
    private readonly instagramProvider: InstagramAnalyticsProvider,
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly repo: AnalyticsRepository,
  ) {
    // Strategy Pattern: Map Enum to Service Instance
    this.providers = new Map<Platform, IAnalyticsProvider>([
      ['LINKEDIN', linkedInProvider],
      ['TWITTER', twitterProvider], // Or 'X' depending on your Enum
      ['FACEBOOK', facebookProvider],
      ['INSTAGRAM', instagramProvider],
    ]);
  }

  /**
   * Fetch Account Health (Followers, Views)
   */
  async fetchAccountStats(
    platform: Platform,
    externalProfileId: string,
    credentials: AuthCredentials,
  ): Promise<AccountMetrics> {
    const provider = this.getProvider(platform);

    this.logger.log(
      `Fetching Account Stats for ${platform}:${externalProfileId}`,
    );

    try {
      return await provider.getAccountStats(externalProfileId, credentials);
    } catch (error) {
      this.logger.error(
        `Failed to fetch account stats for ${platform}`,
        error,
      );
      throw error; // Rethrow so the Worker handles the retry
    }
  }

  /**
   * Fetch Post Performance
   */
  async fetchPostStats(
    platform: Platform,
    externalPostIds: string[],
    credentials: AuthCredentials,
    context?: { pageId?: string }, // Extra context for platforms like LinkedIn
  ): Promise<PostMetrics[]> {
    const provider = this.getProvider(platform);

    this.logger.log(
      `Fetching Post Stats for ${platform} (${externalPostIds.length} posts)`,
    );

    try {
      return await provider.getPostStats(externalPostIds, credentials, context);
    } catch (error) {
      this.logger.error(
        `Failed to fetch post stats for ${platform}`,
        error,
      );
      // Return empty array on failure so we don't crash the whole job?
      // Better to throw if it's a critical network error, but for partials, providers handle it.
      throw error;
    }
  }

  /**
   * Helper: Get the correct provider or throw error
   */
  private getProvider(platform: Platform): IAnalyticsProvider {
    const provider = this.providers.get(platform);
    if (!provider) {
      throw new BadRequestException(
        `No analytics provider implemented for platform: ${platform}`,
      );
    }
    return provider;
  }

  async testFetch(body: { profileId?: string; postDestinationId?: string }) {
    const { profileId, postDestinationId } = body;
    const results: any = {};

    let profile = null;
    let credentials: AuthCredentials | null = null;

    // --- STEP 1: RESOLVE CREDENTIALS
    if (profileId) {
      profile = await this.prisma.socialProfile.findUnique({
        where: { id: profileId },
        include: { connection: true },
      });

      if (!profile) throw new BadRequestException('Profile not found');

      const accessToken = await this.encryptionService.decrypt(
        profile.accessToken,
      );
      let accessSecret: string | undefined;

      if (profile.platform === 'TWITTER' && profile.connection?.refreshToken) {
        accessSecret = await this.encryptionService.decrypt(
          profile.connection.refreshToken,
        );
      }
      credentials = { accessToken, accessSecret };
    }

    // --- STEP 2: ACCOUNT STATS (Only if profileId is provided AND postDestinationId is NOT) ---
    // Or you can add an explicit 'fetchAccount: boolean' flag to the body
    if (profileId && !postDestinationId) {
      try {
        this.logger.debug(
          `🔍 Testing Account Fetch for ${profile.platform}...`,
        );
        results.account = await this.fetchAccountStats(
          profile.platform,
          profile.platformId,
          credentials,
        );
      } catch (e: any) {
        results.accountError = e.response?.data || e.message;
      }
    }

    // --- STEP 3: POST STATS (Only if postDestinationId is provided) ---
    if (postDestinationId) {
      if (!credentials || !profile) {
        throw new BadRequestException(
          'Post testing requires profileId for credentials',
        );
      }

      const post = await this.prisma.postDestination.findUnique({
        where: {
          socialProfileId: profileId,
          id: postDestinationId,
          status: 'SUCCESS',
        },
        select: { id: true, platformPostId: true },
      });

      if (!post)
        throw new BadRequestException(
          'Post destination not found or not successful',
        );

      try {
        this.logger.debug(`🔍 Testing Post Fetch for ${postDestinationId}...`);
        const context =
          profile.platform === 'LINKEDIN'
            ? { pageId: profile.platformId }
            : undefined;
        results.posts = await this.fetchPostStats(
          profile.platform,
          [post.platformPostId],
          credentials,
          context,
        );
      } catch (e: any) {
        this.logger.error(e);
        results.postError = e?.response?.data || e.message;
      }
    }

    return results;
  }

  /**
   * Fetch daily account rows for a specific range.
   */
  async getAccountHistory(socialProfileId: string, start: Date, end: Date) {
    return this.prisma.accountAnalytics.findMany({
      where: {
        socialProfileId,
        date: {
          gte: start,
          lte: end,
        },
      },
      orderBy: { date: 'asc' },
    });
  }

  /**
   * Fetch daily snapshots for a specific post.
   */
  async getPostHistory(postDestinationId: string, start: Date, end: Date) {
    return this.prisma.postAnalyticsSnapshot.findMany({
      where: {
        postDestinationId,
        day: {
          gte: start,
          lte: end,
        },
      },
      orderBy: { day: 'asc' },
    });
  }

  async getWorkspaceDashboard(workspaceId: string, tier: PlanTier, days = 30) {
    const { start, end, prevStart, prevEnd } = this.computePeriods(
      Math.min(days, 365),
    );
    const profileIds = await this.getActiveProfileIds(workspaceId);

    if (profileIds.length === 0) return this.emptyResponse(start, end);

    // Base (Creator-like) always computed
    const base = await this.getWorkspaceCreatorBase(
      workspaceId,
      profileIds,
      start,
      end,
    );

    if (tier === PlanTier.CREATOR) return base;

    const business = await this.getWorkspaceBusiness(
      profileIds,
      start,
      end,
      prevStart,
      prevEnd,
    );

    if (tier === PlanTier.BUSINESS) return { ...base, business };

    const rocket = await this.getWorkspaceRocket(
      workspaceId,
      profileIds,
      start,
      end,
    );

    return { ...base, business, rocket };
  }

  private async getWorkspaceCreatorBase(
    workspaceId: string,
    profileIds: string[],
    start: Date,
    end: Date,
  ) {
    const [followersTotal, engagementTotal, followerSeries, recentPosts] =
      await Promise.all([
        this.getWorkspaceLatestFollowersTotal(profileIds),
        this.getWorkspaceEngagementTotal(profileIds, start, end),
        this.getWorkspaceFollowerGrowthSeriesDB(profileIds, start, end),
        this.getWorkspaceRecentPosts(workspaceId, 5),
      ]);

    return {
      period: { start, end },
      creator: {
        snapshot: { followersTotal, totalEngagement: engagementTotal },
        followerGrowth: followerSeries,
        recentPosts,
      },
    };
  }

  private async getWorkspaceBusiness(
    profileIds: string[],
    start: Date,
    end: Date,
    prevStart: Date,
    prevEnd: Date,
  ) {
    const [currentAgg, prevAgg, heatmapRows, demographicsAgg] =
      await Promise.all([
        this.getWorkspaceAggregatedMetrics(profileIds, start, end),
        this.getWorkspaceAggregatedMetrics(profileIds, prevStart, prevEnd),
        this.getWorkspaceDailyEngagementDB(profileIds, start, end),
        this.getWorkspaceDemographics(profileIds), // keep your "byProfile" approach
      ]);

    const engagementRate = this.calcRate(
      currentAgg.engagement,
      currentAgg.reach || currentAgg.impressions,
    );
    const prevEngagementRate = this.calcRate(
      prevAgg.engagement,
      prevAgg.reach || prevAgg.impressions,
    );

    const maxEng = Math.max(
      0,
      ...heatmapRows.map((r) => r.engagementCount ?? 0),
    );
    const heatmap = heatmapRows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      engagementCount: r.engagementCount ?? 0,
      level: this.intensityByMax(r.engagementCount ?? 0, maxEng),
    }));

    return {
      overview: {
        impressions: this.buildMetric(
          currentAgg.impressions,
          prevAgg.impressions,
        ),
        reach: this.buildMetric(currentAgg.reach, prevAgg.reach),
        profileViews: this.buildMetric(
          currentAgg.profileViews,
          prevAgg.profileViews,
        ),
        clicks: this.buildMetric(currentAgg.clicks, prevAgg.clicks),
        engagementRate: this.buildMetric(engagementRate, prevEngagementRate),
      },
      engagementHeatmap: heatmap,
      demographics: demographicsAgg ?? {},
    };
  }

  private async getWorkspaceRocket(
    workspaceId: string,
    profileIds: string[],
    start: Date,
    end: Date,
  ) {
    const [platformBreakdown, dailyTrafficSeries, currentAgg] =
      await Promise.all([
        this.getWorkspacePlatformBreakdown(workspaceId, start, end),
        this.getWorkspaceDailyTrafficSeriesDB(profileIds, start, end),
        this.getWorkspaceAggregatedMetrics(profileIds, start, end),
      ]);

    const ctr =
      currentAgg.impressions > 0
        ? (currentAgg.clicks / currentAgg.impressions) * 100
        : 0;

    return {
      omnichannelTotals: {
        totalReach: currentAgg.reach,
        totalImpressions: currentAgg.impressions,
        totalProfileViews: currentAgg.profileViews,
        totalClicks: currentAgg.clicks,
        clickThroughRate: Number(ctr.toFixed(2)),
      },
      platformPerformance: platformBreakdown.sort(
        (a, b) => b.clicks - a.clicks,
      ),
      dailyTrafficSeries,
    };
  }

  private async getWorkspaceEngagementTotal(
    profileIds: string[],
    start: Date,
    end: Date,
  ) {
    const agg = await this.prisma.accountAnalytics.aggregate({
      where: {
        socialProfileId: { in: profileIds },
        date: { gte: start, lte: end },
      },
      _sum: { engagementCount: true },
    });
    return agg._sum.engagementCount ?? 0;
  }

  /**
   * Last N posts across the workspace with latest snapshot likes/comments
   */
  private async getWorkspaceRecentPosts(workspaceId: string, take = 5) {
    const posts = await this.prisma.postDestination.findMany({
      where: {
        profile: { workspaceId },
        status: 'SUCCESS',
        platformPostId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        createdAt: true,
        platformPostId: true,
        contentOverride: true,
        profile: { select: { platform: true } },
        postAnalyticsSnapshots: {
          take: 1,
          orderBy: { day: 'desc' },
          select: { likes: true, comments: true },
        },
      },
    });

    return posts.map((p) => ({
      postId: p.id,
      platform: p.profile?.platform,
      content: p.contentOverride,
      platformPostId: p.platformPostId!,
      publishedAt: p.createdAt,
      likes: p.postAnalyticsSnapshots[0]?.likes ?? 0,
      comments: p.postAnalyticsSnapshots[0]?.comments ?? 0,
    }));
  }

  /**
   * Best-effort demographics aggregation.
   * Real talk: demographics aren’t additive. The simplest safe approach is:
   * - pick the latest non-null demographics per profile
   * - return as "byProfile" so frontend can chart per platform/profile
   * - OR do a weighted merge if you track follower counts per profile.
   */
  private async getWorkspaceDemographics(profileIds: string[]) {
    const latest = await this.prisma.accountAnalytics.groupBy({
      by: ['socialProfileId'],
      where: {
        socialProfileId: { in: profileIds },
        demographics: { not: Prisma.DbNull },
      },
      _max: { date: true },
    });

    const or = latest
      .filter((x) => x._max.date)
      .map((x) => ({ socialProfileId: x.socialProfileId, date: x._max.date! }));

    if (or.length === 0) return { byProfile: [] };

    const rows = await this.prisma.accountAnalytics.findMany({
      where: { OR: or },
      select: { socialProfileId: true, demographics: true },
    });

    return {
      byProfile: rows.map((r) => ({
        socialProfileId: r.socialProfileId,
        demographics: r.demographics,
      })),
    };
  }

  // =========================
  // ROCKET EXTRAS
  // =========================

  private async getWorkspacePlatformBreakdown(
    workspaceId: string,
    start: Date,
    end: Date,
  ) {
    const data = await this.prisma.accountAnalytics.findMany({
      where: { socialProfile: { workspaceId }, date: { gte: start, lte: end } },
      select: {
        clicks: true,
        impressions: true,
        reach: true,
        engagementCount: true,
        socialProfile: { select: { platform: true } },
      },
    });

    const breakdown = new Map<
      string,
      { clicks: number; impressions: number; reach: number; engagement: number }
    >();

    for (const row of data) {
      const platform = row.socialProfile.platform;
      if (!breakdown.has(platform))
        breakdown.set(platform, {
          clicks: 0,
          impressions: 0,
          reach: 0,
          engagement: 0,
        });

      const b = breakdown.get(platform)!;
      b.clicks += row.clicks ?? 0;
      b.impressions += row.impressions ?? 0;
      b.reach += row.reach ?? 0;
      b.engagement += row.engagementCount ?? 0;
    }

    return Array.from(breakdown.entries()).map(([platform, stats]) => ({
      platform,
      clicks: stats.clicks,
      impressions: stats.impressions,
      reach: stats.reach,
      engagement: stats.engagement,
    }));
  }

  // =========================
  // Helpers
  // =========================

  private emptyResponse(start: Date, end: Date) {
    return {
      period: { start, end },
      creator: {
        snapshot: { followersTotal: 0, totalEngagement: 0 },
        followerGrowth: [],
        recentPosts: [],
      },
      business: {
        overview: {},
        engagementHeatmap: [],
        demographics: {},
      },
      rocket: {
        omnichannelTotals: {
          totalReach: 0,
          totalImpressions: 0,
          totalProfileViews: 0,
          totalClicks: 0,
          clickThroughRate: 0,
        },
        platformPerformance: [],
        dailyTrafficSeries: [],
      },
    };
  }

  private buildMetric(current: number, previous: number) {
    let growth = 0;
    if (previous > 0) growth = ((current - previous) / previous) * 100;
    else if (current > 0) growth = 100;

    return {
      value: Number(current.toFixed(2)),
      previousValue: Number(previous.toFixed(2)),
      growthPercentage: Number(growth.toFixed(1)),
    };
  }

  private calcRate(engagement: number, reach: number) {
    if (!reach) return 0;
    return (engagement / reach) * 100;
  }

  /**
   * Intensity bucket 0..4 scaled to max
   */
  private intensityByMax(value: number, max: number) {
    if (value <= 0) return 0;
    if (max <= 0) return 1;

    const ratio = value / max;
    if (ratio < 0.25) return 1;
    if (ratio < 0.5) return 2;
    if (ratio < 0.8) return 3;
    return 4;
  }

  private async getWorkspaceLatestFollowersTotal(profileIds: string[]) {
    // 1) For each profile, find its latest date in accountAnalytics
    const latestDates = await this.prisma.accountAnalytics.groupBy({
      by: ['socialProfileId'],
      where: { socialProfileId: { in: profileIds } },
      _max: { date: true },
    });

    // 2) Build OR conditions to fetch the exact latest row per profile
    // NOTE: this assumes (socialProfileId, date) uniquely identifies a snapshot row.
    const or = latestDates
      .filter((x) => x._max.date)
      .map((x) => ({ socialProfileId: x.socialProfileId, date: x._max.date! }));

    if (or.length === 0) return 0;

    const rows = await this.prisma.accountAnalytics.findMany({
      where: { OR: or },
      select: { followersTotal: true },
    });

    return rows.reduce((sum, r) => sum + (r.followersTotal ?? 0), 0);
  }

  private async getWorkspaceDailyEngagementDB(
    profileIds: string[],
    start: Date,
    end: Date,
  ) {
    const rows = await this.prisma.accountAnalytics.groupBy({
      by: ['date'],
      where: {
        socialProfileId: { in: profileIds },
        date: { gte: start, lte: end },
      },
      _sum: { engagementCount: true },
      orderBy: { date: 'asc' },
    });

    return rows.map((r) => ({
      date: r.date,
      engagementCount: r._sum.engagementCount ?? 0,
    }));
  }

  private async getWorkspaceDailyTrafficSeriesDB(
    profileIds: string[],
    start: Date,
    end: Date,
  ) {
    const rows = await this.prisma.accountAnalytics.groupBy({
      by: ['date'],
      where: {
        socialProfileId: { in: profileIds },
        date: { gte: start, lte: end },
      },
      _sum: { clicks: true, impressions: true },
      orderBy: { date: 'asc' },
    });

    return rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      totalClicks: r._sum.clicks ?? 0,
      totalImpressions: r._sum.impressions ?? 0,
    }));
  }

  private async getWorkspaceFollowerGrowthSeriesDB(
    profileIds: string[],
    start: Date,
    end: Date,
  ) {
    const rows = await this.prisma.accountAnalytics.groupBy({
      by: ['date'],
      where: {
        socialProfileId: { in: profileIds },
        date: { gte: start, lte: end },
      },
      _sum: { followersTotal: true },
      orderBy: { date: 'asc' },
    });

    return rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      value: r._sum.followersTotal ?? 0,
    }));
  }

  private async getWorkspaceAggregatedMetrics(
    profileIds: string[],
    start: Date,
    end: Date,
  ) {
    const agg = await this.prisma.accountAnalytics.aggregate({
      where: {
        socialProfileId: { in: profileIds },
        date: { gte: start, lte: end },
      },
      _sum: {
        impressions: true,
        reach: true,
        profileViews: true,
        clicks: true,
        engagementCount: true,
      },
    });

    return {
      impressions: agg._sum.impressions ?? 0,
      reach: agg._sum.reach ?? 0,
      profileViews: agg._sum.profileViews ?? 0,
      clicks: agg._sum.clicks ?? 0,
      engagement: agg._sum.engagementCount ?? 0,
    };
  }

  private async getActiveProfileIds(workspaceId: string): Promise<string[]> {
    const profiles = await this.prisma.socialProfile.findMany({
      where: { workspaceId, isActive: true },
      select: { id: true },
    });
    return profiles.map((p) => p.id);
  }

  private computePeriods(days: number) {
    const end = startOfDay(new Date()); // day bucket end
    const start = startOfDay(subDays(end, days - 1));

    const prevEnd = subDays(start, 1);
    const prevStart = startOfDay(subDays(prevEnd, days - 1));

    return { start, end, prevStart, prevEnd };
  }
}
