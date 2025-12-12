import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { TwitterApi } from 'twitter-api-v2';

@Injectable()
export class AnalyticsPageService {
  private readonly logger = new Logger(AnalyticsPageService.name);
  private readonly META_API_VERSION = 'v23.0';
  private readonly LINKEDIN_API_VERSION = '202501';

  constructor(
    private prisma: PrismaService,
    private httpService: HttpService,
    private encryptionService: EncryptionService,
  ) {}

  async syncFacebookPage(page: any, dateRange: any) {
    try {
      if (!page.accessToken) return;
      const token = await this.encryptionService.decrypt(page.accessToken);

      const url = `https://graph.facebook.com/${this.META_API_VERSION}/${page.platformPageId}/insights`;

      // We fetch "Daily" metrics for yesterday
      const response = await firstValueFrom(
        this.httpService.get(url, {
          params: {
            metric:
              'page_impressions,page_impressions_unique,page_post_engagements',
            period: 'day',
            since: dateRange.start,
            until: dateRange.end,
            access_token: token,
          },
        }),
      );

      const data = response.data.data;
      const followers = await this.fetchMetaFollowers(
        page.platformPageId,
        token,
      );

      await this.saveDailyStats({
        pageAccountId: page.id,
        platform: 'FACEBOOK',
        date: dateRange.dateObj,
        impressions: this.getFbValue(data, 'page_impressions'),
        reach: this.getFbValue(data, 'page_impressions_unique'),
        engagementCount: this.getFbValue(data, 'page_post_engagements'),
        followersTotal: followers,
      });
    } catch (e) {
      this.handleApiError(page, e);
      throw e;
    }
  }

  async syncInstagramAccount(page: any, dateRange: any) {
    try {
      if (!page.instagramBusinessId || !page.accessToken) return;
      const token = await this.encryptionService.decrypt(page.accessToken);

      const url = `https://graph.facebook.com/${this.META_API_VERSION}/${page.instagramBusinessId}/insights`;

      const response = await firstValueFrom(
        this.httpService.get(url, {
          params: {
            metric: 'impressions,reach,profile_views',
            period: 'day',
            since: dateRange.start,
            until: dateRange.end,
            access_token: token,
          },
        }),
      );

      const data = response.data.data;
      const followers = await this.fetchMetaFollowers(
        page.instagramBusinessId,
        token,
      );

      await this.saveDailyStats({
        pageAccountId: page.id,
        platform: 'INSTAGRAM',
        date: dateRange.dateObj,
        impressions: this.getFbValue(data, 'impressions'),
        reach: this.getFbValue(data, 'reach'),
        profileViews: this.getFbValue(data, 'profile_views'),
        engagementCount: 0, // IG Daily Engagement is hard to get via Insights API directly
        followersTotal: followers,
      });
    } catch (e) {
      this.handleApiError(page, e);
      throw e;
    }
  }

  async syncLinkedInPage(page: any, dateRange: any) {
    try{
    if (!page.platformPageId || !page.accessToken) return;
    const token = await this.encryptionService.decrypt(page.accessToken);
    const orgUrn = `urn:li:organization:${page.platformPageId}`;

    const headers = {
      Authorization: `Bearer ${token}`,
      'LinkedIn-Version': '202401',
      'X-Restli-Protocol-Version': '2.0.0',
    };

    // 1. Fetch Follower Count
    const followRes = await firstValueFrom(
      this.httpService.get(
        `https://api.linkedin.com/rest/organizationalEntityFollowerStatistics`,
        {
          headers,
          params: { q: 'organizationalEntity', organizationalEntity: orgUrn },
        },
      ),
    ).catch(() => ({ data: { elements: [] } }));

    const followers =
      followRes.data.elements?.[0]?.followerCountsByAssociation?.reduce(
        (acc, curr) => acc + curr.followerCounts,
        0,
      ) || 0;

    // 2. Fetch Share Stats (Impressions/Engagement for the day)
    const shareRes = await firstValueFrom(
      this.httpService.get(
        `https://api.linkedin.com/rest/organizationalEntityShareStatistics`,
        {
          headers,
          params: {
            q: 'organizationalEntity',
            organizationalEntity: orgUrn,
            'timeIntervals.timeGranularityType': 'DAY',
            'timeIntervals.timeRange.start': dateRange.startMs,
            'timeIntervals.timeRange.end': dateRange.endMs,
          },
        },
      ),
    ).catch(() => ({ data: { elements: [] } }));

    const stats = shareRes.data.elements?.[0]?.totalShareStatistics || {};

    await this.saveDailyStats({
      pageAccountId: page.id,
      platform: 'LINKEDIN',
      date: dateRange.dateObj,
      followersTotal: followers,
      impressions: stats.impressionCount || 0,
      reach: stats.uniqueImpressionsCount || 0,
      engagementCount:
        (stats.clickCount || 0) +
        (stats.likeCount || 0) +
        (stats.shareCount || 0),
    });
  } catch (e) {
      this.handleApiError(page, e);
      throw e;
    }
  }


 async syncTwitterAccount(account: any, dateRange: any) {
    if (!account.accessToken || !account.accessSecret) {
      this.logger.warn(`Missing Twitter credentials for ${account.username}`);
      return;
    }

    try {
      // 2. Decrypt Credentials
      const [token, secret] = await Promise.all([
        this.encryptionService.decrypt(account.accessToken),
        this.encryptionService.decrypt(account.accessSecret),
      ]);

      // 3. Initialize Client
      // We assume you have the app keys in your ConfigService or environment
      const client = new TwitterApi({
        appKey: process.env.X_API_KEY, // Your App Consumer Key
        appSecret: process.env.X_API_SECRET, // Your App Consumer Secret
        accessToken: token,
        accessSecret: secret,
      });

      // 4. Fetch Tweets Posted "Yesterday"
      // This gets all tweets created within the 24h window we are analyzing
      const homeTimeline = await client.v2.userTimeline(account.platformId, {
        start_time: new Date(dateRange.startMs).toISOString(),
        end_time: new Date(dateRange.endMs).toISOString(),
        'tweet.fields': ['public_metrics', 'non_public_metrics'],
        max_results: 100, // Safe limit for one request
      });

      // 5. Fetch User Profile Stats (for Total Follower Count)
      const userMe = await client.v2.me({
        'user.fields': ['public_metrics'],
      });

      // 6. Calculate Aggregates
      // We sum up the metrics of all tweets posted yesterday
      let dailyImpressions = 0;
      let dailyEngagement = 0; // Likes + Reposts + Quotes + Replies

      for (const tweet of homeTimeline.tweets) {
        const pub = tweet.public_metrics;
        const nonPub = tweet.non_public_metrics;

        // Sum Impressions (Private Metric)
        // If non_public is unavailable (due to permissions), fallback to 0
        dailyImpressions += nonPub?.impression_count || 0;

        // Sum Engagement
        dailyEngagement +=
          (pub?.like_count || 0) +
          (pub?.retweet_count || 0) +
          (pub?.reply_count || 0) +
          (pub?.quote_count || 0);
      }

      // 7. Save to DB
      await this.saveDailyStats({
        socialAccountId: account.id,
        platform: 'X',
        date: dateRange.dateObj,
        followersTotal: userMe.data.public_metrics?.followers_count || 0,
        impressions: dailyImpressions,
        engagementCount: dailyEngagement,
        reach: 0, // X does not provide Reach (Unique Views) on Basic Tier
        profileViews: 0, // Not available on Basic Tier
      });
    } catch (e) {
      this.handleApiError(account, e);
      throw e;
    }
  }

  // ===========================================================================
  // 🛠️ HELPERS & UTILS
  // ===========================================================================

  // Helper: Extract value from Facebook's [{ name: '...', values: [{ value: 123 }] }] format
  private getFbValue(data: any[], metricName: string): number {
    return data?.find((m) => m.name === metricName)?.values?.[0]?.value || 0;
  }

  // Helper: Fetch just the follower count for Meta (FB/IG)
  private async fetchMetaFollowers(id: string, token: string): Promise<number> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `https://graph.facebook.com/${this.META_API_VERSION}/${id}`,
          {
            params: { fields: 'followers_count', access_token: token },
          },
        ),
      );
      return response.data.followers_count || 0;
    } catch {
      return 0;
    }
  }

  // Helper: Calculate "Yesterday" range for APIs
  getYesterdayRange() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const endOfYesterday = new Date(yesterday);
    endOfYesterday.setHours(23, 59, 59, 999);

    return {
      dateObj: yesterday,
      start: Math.floor(yesterday.getTime() / 1000), // Unix Timestamp (Seconds) for FB
      end: Math.floor(endOfYesterday.getTime() / 1000),
      startMs: yesterday.getTime(), // Timestamp (Milliseconds) for LinkedIn
      endMs: endOfYesterday.getTime(),
    };
  }

  // Helper: Save to Database (Prisma Upsert)
  private async saveDailyStats(input: {
    socialAccountId?: string;
    pageAccountId?: string;
    platform: any; // Use your Prisma Enum type here
    date: Date;
    impressions?: number;
    reach?: number;
    profileViews?: number;
    engagementCount?: number;
    followersTotal: number;
  }) {
    // 1. Calculate Growth (Today - Yesterday)
    const prevDate = new Date(input.date);
    prevDate.setDate(prevDate.getDate() - 1);

    const prevStat = await this.prisma.accountAnalyticsDaily.findFirst({
      where: {
        socialAccountId: input.socialAccountId,
        pageAccountId: input.pageAccountId,
        platform: input.platform,
        date: prevDate,
      },
    });

    const followersGained = prevStat
      ? input.followersTotal - prevStat.followersTotal
      : 0;

    // 2. Prepare Where Clause (Handle Page vs Social)
    const whereClause = input.pageAccountId
      ? {
          pageAccountId_platform_date: {
            pageAccountId: input.pageAccountId,
            platform: input.platform,
            date: input.date,
          },
        }
      : {
          socialAccountId_platform_date: {
            socialAccountId: input.socialAccountId,
            platform: input.platform,
            date: input.date,
          },
        };

    // 3. Upsert
    const payload = {
      impressions: input.impressions || 0,
      reach: input.reach || 0,
      profileViews: input.profileViews || 0,
      engagementCount: input.engagementCount || 0,
      followersTotal: input.followersTotal,
      followersGained,
    };

    await this.prisma.accountAnalyticsDaily.upsert({
      where: whereClause as any,
      update: payload,
      create: {
        socialAccountId: input.socialAccountId,
        pageAccountId: input.pageAccountId,
        date: input.date,
        platform: input.platform,
        ...payload,
      },
    });
  }

  private async handleApiError(post: any, error: any) {
    // 1. Check for Rate Limits
    if (error.response?.status === 429) {
      this.logger.warn(`Rate Limit Hit for ${post.platform}. Backing off.`);
      // Logic: Push nextAnalyticsCheck forward by 2 hours immediately
      await this.prisma.post.update({
        where: { id: post.id },
        data: { nextAnalyticsCheck: new Date(Date.now() + 2 * 60 * 60 * 1000) },
      });
      return;
    }

    // 2. Check for Expired Tokens (Very Common)
    if (error.response?.data?.error?.code === 190) {
      this.logger.error(`Token Expired for Page ${post.pageAccount.id}`);
    }
  }
}
