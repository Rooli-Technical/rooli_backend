import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { PageAccount, SocialAccount } from '@generated/client';
import { Platform } from '@generated/enums';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

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
    const followers = await this.fetchMetaFollowers(page.platformPageId, token);

    await this.saveDailyStats({
      pageAccountId: page.id,
      platform: 'FACEBOOK',
      date: dateRange.dateObj,
      impressions: this.getFbValue(data, 'page_impressions'),
      reach: this.getFbValue(data, 'page_impressions_unique'),
      engagementCount: this.getFbValue(data, 'page_post_engagements'),
      followersTotal: followers,
    });
  }

  async syncInstagramAccount(page: any, dateRange: any) {
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
  }

 async syncLinkedInPage(page: any, dateRange: any) {
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

    const followers = followRes.data.elements?.[0]?.followerCountsByAssociation?.reduce(
       (acc, curr) => acc + curr.followerCounts, 0
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
      engagementCount: (stats.clickCount || 0) + (stats.likeCount || 0) + (stats.shareCount || 0),
    });
  }

 async syncTwitterAccount(account: any, dateRange: any) {
    if (!account.accessToken) return;
    // Note: If using OAuth 1.0a, you need token + secret. 
    // If using OAuth 2.0 (Bearer), just token. Assuming Bearer for simple read.
    const token = await this.encryptionService.decrypt(account.accessToken);

    // X API v2 User Metrics (Basic)
    const response = await firstValueFrom(
        this.httpService.get(`https://api.twitter.com/2/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { 'user.fields': 'public_metrics' },
        }),
    );

    const metrics = response.data.data.public_metrics;

    await this.saveDailyStats({
      socialAccountId: account.id, 
      platform: 'X',
      date: dateRange.dateObj,
      followersTotal: metrics.followers_count,
      // X Basic API does not give historical impressions per day easily
      impressions: 0, 
      reach: 0,
      engagementCount: 0,
    });
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
        this.httpService.get(`https://graph.facebook.com/${this.META_API_VERSION}/${id}`, {
          params: { fields: 'followers_count', access_token: token },
        }),
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
      start: Math.floor(yesterday.getTime() / 1000),     // Unix Timestamp (Seconds) for FB
      end: Math.floor(endOfYesterday.getTime() / 1000),
      startMs: yesterday.getTime(),                      // Timestamp (Milliseconds) for LinkedIn
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
}
