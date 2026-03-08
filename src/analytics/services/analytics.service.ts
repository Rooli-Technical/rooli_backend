import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuthCredentials,
  FetchAccountResult,
  FetchPostResult,
  IAnalyticsProvider,
} from '../interfaces/analytics-provider.interface';
import { FacebookAnalyticsProvider } from '../providers/facebook-analytics.provider';
import { InstagramAnalyticsProvider } from '../providers/instagram-analytics.provider';
import { LinkedInAnalyticsProvider } from '../providers/linkedin.provider';
import { TwitterAnalyticsProvider } from '../providers/twitter.provider';
import { PlanTier, Platform } from '@generated/enums';
import { PrismaService } from '@/prisma/prisma.service';
import { EncryptionService } from '@/common/utility/encryption.service';
import { AnalyticsRepository } from './analytics.repository';
import { startOfDay } from 'date-fns/startOfDay';
import { subDays } from 'date-fns/subDays';
import { AnalyticsNormalizerService } from './analytics-normalizer.service';
import { DateTime } from 'luxon';

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
    private readonly normalizer: AnalyticsNormalizerService,
  ) {
    // Strategy Pattern: Map Enum to Service Instance
    this.providers = new Map<Platform, IAnalyticsProvider>([
      ['LINKEDIN', linkedInProvider],
      ['TWITTER', twitterProvider],
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
  ): Promise<FetchAccountResult> {
    const provider = this.getProvider(platform);
    this.logger.log(
      `Fetching Account Stats for ${platform}:${externalProfileId}`,
    );
    try {
      return await provider.getAccountStats(externalProfileId, credentials);
    } catch (error) {
      this.logger.error(`Failed to fetch account stats for ${platform}`, error);
      throw error;
    }
  }

  /**
   * Fetch Post Performance
   */
  async fetchPostStats(
    platform: Platform,
    externalPostIds: string[],
    credentials: AuthCredentials,
    context?: { pageId?: string },
  ): Promise<FetchPostResult[]> {
    const provider = this.getProvider(platform);
    this.logger.log(
      `Fetching Post Stats for ${platform} (${externalPostIds.length} posts)`,
    );
    try {
      return await provider.getPostStats(externalPostIds, credentials, context);
    } catch (error) {
      this.logger.error(`Failed to fetch post stats for ${platform}`, error);
      throw error;
    }
  }

  /**
   * Fetch detailed analytics for a single social profile
   */
  async getProfileDashboard(
    profileId: string,
    days?: number,
    startDate?: string,
    endDate?: string,
  ) {
    const { start, end } = this.computePeriods(days, startDate, endDate);

    // 1. Fetch the Profile to know what platform we are dealing with
    const profile = await this.prisma.socialProfile.findUnique({
      where: { id: profileId },
      select: { platform: true, name: true },
    });

    if (!profile) throw new NotFoundException('Profile not found');

    // 2. Fetch the Account Level History (Includes Demographics & Specifics)
    const accountHistory = await this.prisma.accountAnalytics.findMany({
      where: {
        socialProfileId: profileId,
        date: { gte: start, lte: end },
      },
      orderBy: { date: 'asc' },
      include: {
        twitterStats: true,
        linkedInStats: true,
        facebookStats: true,
        instagramStats: true,
      },
    });

    // 3. Fetch the Post Level History (Top posts for this profile)
    const topPosts = await this.prisma.postAnalyticsSnapshot.findMany({
      where: {
        postDestination: { socialProfileId: profileId },
        day: { gte: start, lte: end },
      },
      orderBy: { engagementCount: 'desc' }, // Sort by our unified engagement!
      take: 10,
      include: {
        twitterStats: true,
        linkedInStats: true,
        facebookStats: true,
        instagramStats: true,
        postDestination: {
          select: { platformPostId: true, contentOverride: true },
        },
      },
    });

    // 4. Clean up the payload so the frontend doesn't get a bunch of nulls
    const cleanAccountHistory = accountHistory.map((row) => ({
      date: row.date,
      base: {
        followers: row.followersTotal,
        impressions: row.impressions,
        engagement: row.engagementCount,
      },
      // Dynamically attach ONLY the specific stats that exist
      specific:
        row.twitterStats ||
        row.linkedInStats ||
        row.facebookStats ||
        row.instagramStats ||
        {},
    }));

    const cleanTopPosts = topPosts.map((post) => ({
      postId: post.postDestination.platformPostId,
      content: post.postDestination.contentOverride,
      base: {
        likes: post.likes,
        comments: post.comments,
        impressions: post.impressions,
      },
      // Dynamically attach ONLY the specific stats that exist
      specific:
        post.twitterStats ||
        post.linkedInStats ||
        post.facebookStats ||
        post.instagramStats ||
        {},
    }));

    // 5. Return the unified payload
    return {
      platform: profile.platform,
      handle: profile.name,
      period: { start, end },
      accountHistory: cleanAccountHistory,
      topPosts: cleanTopPosts,
    };
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

    // --- STEP 1: RESOLVE CREDENTIALS ---
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

    // --- STEP 2: ACCOUNT STATS ---
    if (profileId && !postDestinationId) {
      try {
        this.logger.debug(
          `🔍 Testing Account Fetch & Save for ${profile.platform}...`,
        );

        const rawAccount = await this.fetchAccountStats(
          profile.platform,
          profile.platformId,
          credentials,
        );

        const accountPayload = await this.normalizer.normalizeAccountStats(
          profile.id,
          profile.platform,
          rawAccount,
        );
        await this.repo.saveAccountAnalytics(accountPayload);

        results.account = accountPayload;
        results.accountSaved = true;
      } catch (e: any) {
        this.logger.error(`Account save failed: ${e.message}`);
        results.accountError = e.response?.data || e.message;
      }
    }

    // --- STEP 3: POST STATS ---
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
      });

      if (!post)
        throw new BadRequestException(
          'Post destination not found or not successful',
        );

      try {
        this.logger.debug(
          `🔍 Testing Post Fetch & Save for ${postDestinationId}...`,
        );

        const context =
          profile.platform === 'LINKEDIN'
            ? { pageId: profile.platformId }
            : undefined;

        // Fetch (Returns array)
        const rawPosts = await this.fetchPostStats(
          profile.platform,
          [post.platformPostId],
          credentials,
          context,
        );

        if (rawPosts && rawPosts.length > 0) {
          // Normalize
          const postPayload = this.normalizer.normalizePostStats(
            post.id,
            profile.platform, // Add platform here
            rawPosts[0],
          );
          await this.repo.savePostSnapshot(postPayload);

          results.post = postPayload;
          results.postSaved = true;
        } else {
          results.postError = 'No data returned from platform for this post ID';
        }
      } catch (e: any) {
        this.logger.error(`Post save failed: ${e.message}`);
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

  async getWorkspaceDashboard(
    workspaceId: string,
    tier: PlanTier,
    days?: number,
    startDate?: string,
    endDate?: string,
  ) {
    const { start, end, prevStart, prevEnd } = this.computePeriods(
      days,
      startDate,
      endDate,
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

  /**
   * Calculates the best day and hour to post based on historical engagement.
   * Returns a 168-hour matrix (7 days x 24 hours) for a UI Heatmap.
   */
  async getBestTimeToPost(profileId: string, days = 90) {
    const profile = await this.prisma.socialProfile.findUnique({
      where: { id: profileId },
      select: { platform: true, name: true }
    });

    if (!profile) throw new NotFoundException('Profile not found');

    const startDate = subDays(new Date(), days);


    // 2. Fetch historical posts and their final engagement count
    const posts = await this.prisma.postDestination.findMany({
      where: {
        socialProfileId: profileId,
        status: 'SUCCESS', // Only count successfully published posts
        createdAt: { gte: startDate },
      },
      select: {
        createdAt: true, // The exact time it was published
        postAnalyticsSnapshots: {
          orderBy: { day: 'desc' }, // Get the most recent snapshot
          take: 1,
          select: { engagementCount: true },
        },
      },
    });

    // 3. Initialize the 168-hour week map (7 days * 24 hours)
    // Key format: "day-hour" (e.g., "1-14" = Monday 14:00 / 2 PM)
    const heatmapMap = new Map<string, { totalEng: number; count: number }>();

    // Pre-fill the map so the frontend receives a perfect 7x24 grid,
    // even for hours where the user has never posted.
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        heatmapMap.set(`${d}-${h}`, { totalEng: 0, count: 0 });
      }
    }

    // 4. Aggregate the engagement data
    for (const post of posts) {
      // NOTE: .getUTCDay() and .getUTCHours() extract the time in UTC.
      // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
      const day = post.createdAt.getUTCDay();
      const hour = post.createdAt.getUTCHours();
      const key = `${day}-${hour}`;

      const engagement = post.postAnalyticsSnapshots[0]?.engagementCount || 0;

      const current = heatmapMap.get(key)!;
      current.totalEng += engagement;
      current.count += 1;
    }

    // 5. Calculate Averages & Find the Maximum Average
    let maxAverage = 0;
    const rawResults = [];

    for (const [key, data] of heatmapMap.entries()) {
      const [dayStr, hourStr] = key.split('-');

      // We use average engagement so posting 5 times at 9AM doesn't
      // artificially beat a single viral post at 2PM.
      const average = data.count > 0 ? data.totalEng / data.count : 0;

      if (average > maxAverage) {
        maxAverage = average;
      }

      rawResults.push({
        day: parseInt(dayStr, 10),
        hour: parseInt(hourStr, 10),
        averageEngagement: Number(average.toFixed(2)),
        postCount: data.count,
      });
    }

    // 6. Apply the intensity scale and find the absolute best time
    let bestTime = null;

    const heatmap = rawResults.map((r) => {
      // Re-use your existing intensityByMax helper!
      const intensity = this.intensityByMax(r.averageEngagement, maxAverage);

      // Keep track of the highest performing slot for the summary
      if (!bestTime || r.averageEngagement > bestTime.averageEngagement) {
        bestTime = { ...r, intensity };
      }

      return { ...r, intensity };
    });

    return {
      profile: {
        id: profileId,
        platform: profile.platform,
        handle: profile.name,
      },
      // A quick summary object so the UI can say: "Your best time to post is Monday at 14:00"
      summary: {
        hasData: posts.length > 0,
        bestDay: bestTime?.day ?? null,
        bestHour: bestTime?.hour ?? null,
        maxAverageEngagement: Number(maxAverage.toFixed(2)),
        totalPostsAnalyzed: posts.length,
      },
      // The full array to render the grid
      heatmap,
    };
  }

  private async getWorkspaceBusiness(
    profileIds: string[],
    start: Date,
    end: Date,
    prevStart: Date,
    prevEnd: Date,
  ) {
    const [currentAgg, prevAgg, heatmapRows, demographicsAgg, topPosts] =
      await Promise.all([
        this.getWorkspaceAggregatedMetrics(profileIds, start, end),
        this.getWorkspaceAggregatedMetrics(profileIds, prevStart, prevEnd),
        this.getWorkspaceDailyEngagementDB(profileIds, start, end),
        this.getWorkspaceDemographics(profileIds), 
        this.getWorkspaceTopPostsPerPlatform(profileIds, start, end),
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
      topPerformingPosts: topPosts,
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

  async getDashboardPosts(workspaceId: string) {
    const [lastPublished, lastRecent] = await Promise.all([
      this.getWorkspaceRecentPosts(workspaceId),

      this.prisma.post.findMany({
        where: {
          workspaceId,
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          destinations: {
            select: {
              status: true,
              profile: { select: { platform: true } },
            },
          },
        },
      }),
    ]);

    return { lastPublished, lastRecent };
  }

  /**
   * Best-effort demographics aggregation (Updated for Relational Architecture)
   */
  private async getWorkspaceDemographics(profileIds: string[]) {
    // 1. Find the latest analytics date for each profile
    const latest = await this.prisma.accountAnalytics.groupBy({
      by: ['socialProfileId'],
      where: {
        socialProfileId: { in: profileIds },
      },
      _max: { date: true },
    });

    // 2. Build the exact row conditions
    const orConditions = latest
      .filter((x) => x._max.date)
      .map((x) => ({ socialProfileId: x.socialProfileId, date: x._max.date! }));

    if (orConditions.length === 0) return { byProfile: [] };

    // 3. Fetch the rows AND include the specific platform tables
    const rows = await this.prisma.accountAnalytics.findMany({
      where: { OR: orConditions },
      include: {
        linkedInStats: true,
        facebookStats: true,
        instagramStats: true,
        // Twitter doesn't have demographics in our schema, so we skip it
      },
    });

    // 4. Extract the demographics from whichever platform relation is populated
    const byProfile = rows
      .map((r) => {
        // Look inside the relations for the demographics JSON
        const demographics =
          r.linkedInStats?.demographics ||
          r.facebookStats?.demographics ||
          r.instagramStats?.demographics ||
          null;

        return {
          socialProfileId: r.socialProfileId,
          demographics,
        };
      })
      // Optional: Filter out profiles that didn't have demographics (like Twitter)
      .filter((p) => p.demographics !== null);

    return { byProfile };
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

  private computePeriods(days?: number, startDate?: string, endDate?: string) {
    let start: DateTime;
    let end: DateTime;

    if (startDate && endDate) {
      // 1. User provided a specific range
      start = DateTime.fromISO(startDate).startOf('day');
      end = DateTime.fromISO(endDate).endOf('day');

      if (!start.isValid || !end.isValid) {
        throw new BadRequestException('Invalid date format. Use YYYY-MM-DD.');
      }
    } else {
      // 2. Fallback to rolling "days" (e.g., last 30 days)
      const lookback = Math.min(days || 30, 365);
      end = DateTime.now().endOf('day');
      start = end.minus({ days: lookback - 1 }).startOf('day');
    }

    // 3. Calculate the "Previous Period" for growth metrics
    // We determine the number of days in the current selection
    // and jump back that same amount of time.
    const diffInDays = Math.floor(end.diff(start, 'days').days) + 1;

    const prevEnd = start.minus({ seconds: 1 }).endOf('day');
    const prevStart = prevEnd.minus({ days: diffInDays - 1 }).startOf('day');

    return {
      start: start.toJSDate(),
      end: end.toJSDate(),
      prevStart: prevStart.toJSDate(),
      prevEnd: prevEnd.toJSDate(),
    };
  }

  /**
   * Fetches the top 3 best performing posts for EACH platform in the workspace.
   */
  private async getWorkspaceTopPostsPerPlatform(profileIds: string[], start: Date, end: Date, takePerPlatform = 3) {
    // 1. Fetch snapshots in the date range, ordered globally by highest engagement
    const snapshots = await this.prisma.postAnalyticsSnapshot.findMany({
      where: {
        postDestination: { socialProfileId: { in: profileIds } },
        day: { gte: start, lte: end },
      },
      orderBy: { engagementCount: 'desc' },
      include: {
        postDestination: {
          include: { profile: { select: { platform: true, name: true } } }
        }
      }
    });

    // 2. Deduplicate (ensure we only track the highest snapshot per post)
    const seenPostIds = new Set<string>();
    
    // 3. Initialize buckets for the platforms
    const results: Record<string, any[]> = {
      TWITTER: [],
      LINKEDIN: [],
      FACEBOOK: [],
      INSTAGRAM: []
    };

    // 4. Sort into buckets until each bucket hits the limit
    for (const snap of snapshots) {
      const destId = snap.postDestinationId;
      if (seenPostIds.has(destId)) continue; // Skip older snapshots of the same post
      
      seenPostIds.add(destId);

      const platform = snap.postDestination.profile.platform;
      
      // If we haven't hit the limit (e.g., 3) for this platform yet, add it!
      if (results[platform] && results[platform].length < takePerPlatform) {
        results[platform].push({
          id: snap.postDestination.id,
          platformPostId: snap.postDestination.platformPostId,
          content: snap.postDestination.contentOverride,
          handle: snap.postDestination.profile.name,
          platform: platform,
          publishedAt: snap.postDestination.createdAt,
          metrics: {
            engagement: snap.engagementCount ?? 0,
            likes: snap.likes ?? 0,
            comments: snap.comments ?? 0,
            impressions: snap.impressions ?? 0,
          }
        });
      }
    }

    return results;
  }
}
