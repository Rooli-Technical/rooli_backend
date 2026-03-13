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

  // 1. Fetch the profile
  const profile = await this.prisma.socialProfile.findUnique({
    where: { id: profileId },
    select: { platform: true, name: true, type: true },
  });

  if (!profile) throw new NotFoundException('Profile not found');

  // 2. Fetch account history + top posts in parallel — no reason to waterfall these
  const [accountHistory, topPostIds] = await Promise.all([
    this.prisma.accountAnalytics.findMany({
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
    }),

    // Raw query: DISTINCT ON gives us the best snapshot per post, sorted by engagement
    this.prisma.$queryRaw<{ postDestinationId: string }[]>`
      SELECT DISTINCT ON (s."postDestinationId")
        s."postDestinationId"
      FROM "PostAnalyticsSnapshot" s
      INNER JOIN "PostDestination" d ON d.id = s."postDestinationId"
      WHERE d."socialProfileId" = ${profileId}
        AND s.day >= ${start}
        AND s.day <= ${end}
      ORDER BY s."postDestinationId", s."engagementCount" DESC NULLS LAST
      LIMIT 10
    `,
  ]);

  // 3. Calculate growth summary
  const growthSummary = {
    followerGrowth: 0,
    followerPercent: 0,
    totalImpressions: 0,
    totalEngagement: 0,
  };

  if (accountHistory.length > 0) {
    const firstEntry = accountHistory[0];
    const lastEntry = accountHistory[accountHistory.length - 1];

    growthSummary.totalImpressions = accountHistory.reduce(
      (sum, row) => sum + (row.impressions ?? 0),
      0,
    );
    growthSummary.totalEngagement = accountHistory.reduce(
      (sum, row) => sum + (row.engagementCount ?? 0),
      0,
    );

    const initialFollowers = firstEntry.followersTotal ?? 0;
    const currentFollowers = lastEntry.followersTotal ?? 0;
    growthSummary.followerGrowth = currentFollowers - initialFollowers;

    if (initialFollowers > 0) {
      growthSummary.followerPercent = parseFloat(
        ((growthSummary.followerGrowth / initialFollowers) * 100).toFixed(2),
      );
    } else if (growthSummary.followerGrowth > 0) {
      growthSummary.followerPercent = 100;
    }
  }

  // 4. Hydrate the top posts via Prisma for full typing — raw query only gave us the IDs
  const destinationIds = topPostIds.map((r) => r.postDestinationId);

  const topPosts = destinationIds.length > 0
    ? await this.prisma.postAnalyticsSnapshot.findMany({
        where: { postDestinationId: { in: destinationIds } },
        orderBy: { engagementCount: 'desc' },
        distinct: ['postDestinationId'],
        include: {
          twitterStats: true,
          linkedInStats: true,
          facebookStats: true,
          instagramStats: true,
          postDestination: {
            select: {
              platformPostId: true,
              contentOverride: true,
              createdAt: true,
              publishedAt: true,
              post: { select: { scheduledAt: true } },
            },
          },
        },
      })
    : [];

  // 5. Shape the top posts payload
  const cleanTopPosts = topPosts.map((snapshot) => {
    const dest = snapshot.postDestination;
    const bestPublishedDate =
      dest.publishedAt ?? dest.post?.scheduledAt ?? dest.createdAt;

    return {
      postId: dest.platformPostId,
      content: dest.contentOverride,
      publishedAt: bestPublishedDate,
      base: {
        likes: snapshot.likes ?? 0,
        comments: snapshot.comments ?? 0,
        impressions: snapshot.impressions ?? 0,
        engagement: snapshot.engagementCount ?? 0,
      },
      specific:
        snapshot.twitterStats ??
        snapshot.linkedInStats ??
        snapshot.facebookStats ??
        snapshot.instagramStats ??
        {},
    };
  });

  // 6. Shape the account history payload
  const cleanAccountHistory = accountHistory.map((row) => ({
    date: row.date,
    base: {
      followers: row.followersTotal ?? 0,
      impressions: row.impressions ?? 0,
      engagement: row.engagementCount ?? 0,
    },
    specific:
      row.twitterStats ??
      row.linkedInStats ??
      row.facebookStats ??
      row.instagramStats ??
      {},
  }));

  // 7. Return unified payload
  return {
    platform: profile.platform,
    handle: profile.name,
    period: { start, end },
    summary: growthSummary,
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
      include: {
        socialProfile: { select: { platform: true, name: true, type: true } },
      },
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
      include: {
        postDestination: {
          select: {
            platformPostId: true,
            contentOverride: true,
            profile: { select: { platform: true, name: true, type: true } },
          },
        },
      },
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
  async getWorkspaceBestTimeToPost(workspaceId: string, days = 90) {
    const startDate = subDays(new Date(), days);

    // 1. Fetch ALL successful posts for the entire workspace
    const posts = await this.prisma.postDestination.findMany({
      where: {
        profile: { workspaceId },
        status: 'SUCCESS',
        createdAt: { gte: startDate },
      },
      select: {
        publishedAt: true,
        createdAt: true,
        profile: { select: { platform: true } },
        postAnalyticsSnapshots: {
          orderBy: { day: 'desc' },
          take: 1,
          select: { engagementCount: true },
        },
      },
    });

    // 2. Initialize our data structures
    const platforms = ['LINKEDIN', 'TWITTER', 'FACEBOOK', 'INSTAGRAM'];

    // We will store the raw data here before formatting
    const rawData: Record<
      string,
      Map<string, { totalEng: number; count: number }>
    > = {
      WORKSPACE: this.createEmptyHeatmapMap(),
    };

    platforms.forEach((p) => (rawData[p] = this.createEmptyHeatmapMap()));

    // 3. Single-pass aggregation!
    for (const post of posts) {
      const publishTime = post.publishedAt ?? post.createdAt;
      const day = publishTime.getUTCDay();
      const hour = publishTime.getUTCHours();
      const key = `${day}-${hour}`;
      const engagement = post.postAnalyticsSnapshots[0]?.engagementCount || 0;
      const platform = post.profile.platform;

      // Add to Workspace Aggregate
      const wsCurrent = rawData['WORKSPACE'].get(key)!;
      wsCurrent.totalEng += engagement;
      wsCurrent.count += 1;

      // Add to Specific Platform
      if (rawData[platform]) {
        const platCurrent = rawData[platform].get(key)!;
        platCurrent.totalEng += engagement;
        platCurrent.count += 1;
      }
    }

    // 4. Format the final output
    const response: Record<string, any> = {};

    for (const [scope, mapData] of Object.entries(rawData)) {
      response[scope] = this.formatHeatmap(mapData);
    }

    return response;
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
        postId: true,
        createdAt: true,
        platformPostId: true,
        contentOverride: true,
        profile: { select: { platform: true, type: true } },
        postAnalyticsSnapshots: {
          take: 1,
          orderBy: { day: 'desc' },
          select: { likes: true, comments: true },
        },
      },
    });

    return posts.map((p) => ({
      postId: p.postId,
      postDestinationId: p.id,
      platform: p.profile?.platform,
      content: p.contentOverride,
      platformPostId: p.platformPostId!,
      type: p.profile?.type,
      publishedAt: p.createdAt,
      likes: p.postAnalyticsSnapshots[0]?.likes ?? 0,
      comments: p.postAnalyticsSnapshots[0]?.comments ?? 0,
    }));
  }

  async getAppHomeDashboard(workspaceId: string) {
    // 1. Define the "Quick Pulse" Timeframes (Last 7 Days vs Previous 7 Days)
    const now = new Date();
    const startOfPulse = subDays(now, 7);
    const startOfPrevPulse = subDays(now, 14);

    const profileIds = await this.getActiveProfileIds(workspaceId);

    // 2. Fetch the KPI Data in parallel
    const [
      currentEngagement,
      prevEngagement,
      currentFollowers,
      prevFollowers,
      currentPublishedCount,
      prevPublishedCount,
    ] = await Promise.all([
      // Engagement
      this.getWorkspaceEngagementTotal(profileIds, startOfPulse, now),
      this.getWorkspaceEngagementTotal(
        profileIds,
        startOfPrevPulse,
        startOfPulse,
      ),
      this.getWorkspaceLatestFollowersTotal(profileIds), // current
      this.getWorkspaceEarliestFollowersTotal(
        profileIds,
        startOfPrevPulse,
        startOfPulse,
      ), // prev
      this.prisma.post.count({
        where: {
          workspaceId,
          status: 'PUBLISHED',
          createdAt: { gte: startOfPulse, lte: now },
        },
      }),
      this.prisma.post.count({
        where: {
          workspaceId,
          status: 'PUBLISHED',
          createdAt: { gte: startOfPrevPulse, lt: startOfPulse },
        },
      }),
    ]);

    const [recentPosts, upcomingPosts] = await Promise.all([
      // RECENT: Already published, newest first
      this.prisma.post.findMany({
        where: {
          workspaceId,
          status: {
            in: ['PUBLISHED', 'PARTIAL'],
          },
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

      // UPCOMING: Scheduled for the future, soonest first
      this.prisma.post.findMany({
        where: {
          workspaceId,
          status: 'SCHEDULED', // Adjust this if your enum value is different
          scheduledAt: { gte: now }, // Only grab posts meant for the future
        },
        orderBy: { scheduledAt: 'asc' }, // The post going out SOONEST is at the top
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

    return {
      kpis: {
        engagement: this.buildMetric(currentEngagement, prevEngagement),
        publishedPosts: this.buildMetric(
          currentPublishedCount,
          prevPublishedCount,
        ),
        totalAudience: {
          value: currentFollowers,
          // Placeholder for audience growth until you track historical follower counts perfectly
          growthPercentage: 0,
        },
      },
      recentPosts,
      upcomingPosts,
    };
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
        socialProfile: { select: { platform: true, name: true, type: true } },
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
          platform: r.socialProfile.platform,
          handle: r.socialProfile.name,
          type: r.socialProfile.type,
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
    if (profileIds.length === 0) return 0;

    const result = await this.prisma.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(a."followersTotal"), 0) AS total
    FROM "AccountAnalytics" a
    INNER JOIN (
      SELECT "socialProfileId", MAX(date) AS max_date
      FROM "AccountAnalytics"
      WHERE "socialProfileId" = ANY(${profileIds})
      GROUP BY "socialProfileId"
    ) latest
    ON a."socialProfileId" = latest."socialProfileId"
    AND a.date = latest.max_date
  `;

    return Number(result[0]?.total ?? 0);
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
      if (days && days > 365) {
        throw new BadRequestException('Date range cannot exceed 365 days.');
      }
      const lookback = days || 30;
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
  private async getWorkspaceTopPostsPerPlatform(
    profileIds: string[],
    start: Date,
    end: Date,
    takePerPlatform = 3,
  ) {
    // 1. Fetch snapshots in the date range, ordered globally by highest engagement
    const platforms = ['TWITTER', 'LINKEDIN', 'FACEBOOK', 'INSTAGRAM'];

    const results = Object.fromEntries(platforms.map((p) => [p, []]));

    await Promise.all(
      platforms.map(async (platform) => {
        const snapshots = await this.prisma.postAnalyticsSnapshot.findMany({
          where: {
            postDestination: {
              socialProfileId: { in: profileIds },
              profile: { platform: platform as any },
            },
            day: { gte: start, lte: end },
          },
          orderBy: { engagementCount: 'desc' },
          take: takePerPlatform * 5, // small buffer for dedup only
          include: {
            postDestination: {
              include: {
                profile: { select: { platform: true, name: true, type: true } },
              },
            },
          },
        });

        const seen = new Set<string>();
        for (const snap of snapshots) {
          if (seen.has(snap.postDestinationId)) continue;
          seen.add(snap.postDestinationId);
          if (results[platform].length >= takePerPlatform) break;
          results[platform].push({
            id: snap.postDestination.id,
            platformPostId: snap.postDestination.platformPostId,
            content: snap.postDestination.contentOverride,
            handle: snap.postDestination.profile.name,
            platform: platform,
            type: snap.postDestination.profile.type,
            publishedAt: snap.postDestination.createdAt,
            metrics: {
              engagement: snap.engagementCount ?? 0,
              likes: snap.likes ?? 0,
              comments: snap.comments ?? 0,
              impressions: snap.impressions ?? 0,
            },
          });
        }
      }),
    );

    return results;
  }

  private createEmptyHeatmapMap() {
    const map = new Map<string, { totalEng: number; count: number }>();
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        map.set(`${d}-${h}`, { totalEng: 0, count: 0 });
      }
    }
    return map;
  }

  private formatHeatmap(
    mapData: Map<string, { totalEng: number; count: number }>,
  ) {
    let maxAverage = 0;
    const rawResults = [];
    let totalPostsAnalyzed = 0;

    for (const [key, data] of mapData.entries()) {
      const [dayStr, hourStr] = key.split('-');
      const average = data.count > 0 ? data.totalEng / data.count : 0;

      if (average > maxAverage) maxAverage = average;
      totalPostsAnalyzed += data.count;

      rawResults.push({
        day: parseInt(dayStr, 10),
        hour: parseInt(hourStr, 10),
        averageEngagement: Number(average.toFixed(2)),
        postCount: data.count,
      });
    }

    let bestTime = null;
    const heatmap = rawResults.map((r) => {
      const intensity = this.intensityByMax(r.averageEngagement, maxAverage);
      if (!bestTime || r.averageEngagement > bestTime.averageEngagement) {
        bestTime = { ...r, intensity };
      }
      return { ...r, intensity };
    });

    return {
      summary: {
        hasData: totalPostsAnalyzed > 0,
        bestDay: bestTime?.day ?? null,
        bestHour: bestTime?.hour ?? null,
        maxAverageEngagement: Number(maxAverage.toFixed(2)),
        totalPostsAnalyzed,
      },
      heatmap,
    };
  }

  private async getWorkspaceEarliestFollowersTotal(
    profileIds: string[],
    start: Date,
    end: Date,
  ) {
    const earliestDates = await this.prisma.accountAnalytics.groupBy({
      by: ['socialProfileId'],
      where: {
        socialProfileId: { in: profileIds },
        date: { gte: start, lte: end },
      },
      _min: { date: true },
    });

    const or = earliestDates
      .filter((x) => x._min.date)
      .map((x) => ({ socialProfileId: x.socialProfileId, date: x._min.date! }));

    if (or.length === 0) return 0;

    const rows = await this.prisma.accountAnalytics.findMany({
      where: { OR: or },
      select: { followersTotal: true },
    });

    return rows.reduce((sum, r) => sum + (r.followersTotal ?? 0), 0);
  }
}
