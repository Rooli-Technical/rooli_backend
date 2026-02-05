import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Platform } from '@generated/enums';
import {
  AccountMetrics,
  AuthCredentials,
  IAnalyticsProvider,
  PostMetrics,
} from '../interfaces/analytics-provider.interface';
import { DateTime } from 'luxon';
import * as https from 'https';

@Injectable()
export class LinkedInAnalyticsProvider implements IAnalyticsProvider {
  platform: Platform = 'LINKEDIN';
  private readonly logger = new Logger(LinkedInAnalyticsProvider.name);
  private readonly baseUrl = 'https://api.linkedin.com/rest';

  constructor(private readonly http: HttpService) {}

  private httpsAgent = new https.Agent({
    family: 4, // Force IPv4 (Disable IPv6)
    keepAlive: true,
    timeout: 30000,
  });

  private headers(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      'LinkedIn-Version': '202601',
      'X-Restli-Protocol-Version': '2.0.0',
    };
  }

  async getAccountStats(
    id: string,
    credentials: AuthCredentials,
  ): Promise<AccountMetrics> {
    const token = credentials.accessToken;
    const fullUrn = this.ensureUrn(id);
    if (fullUrn.includes('organization')) {
      return this.getOrganizationStats(fullUrn, token);
    }
    return this.getPersonalProfileStats(fullUrn, token);
  }

  private async getOrganizationStats(
    orgUrn: string,
    token: string,
  ): Promise<AccountMetrics> {
    try {
      const headers = this.headers(token);
      const { period } = this.getAnalyticsWindow();

      const timeIntervalsParam = `(timeRange:(start:${period.from},end:${period.to}),timeGranularityType:DAY)`;

      const followerUrl = `${this.baseUrl}/organizationalEntityFollowerStatistics`;
      const pageUrl = `${this.baseUrl}/organizationPageStatistics`;
      const shareUrl = `${this.baseUrl}/organizationalEntityShareStatistics`;

      const linkedinSerializer = (params: any) => {
        const parts = Object.entries(params).map(([key, value]) => {
          if (key === 'timeIntervals') {
            // Do NOT encode the parentheses or colons for this specific field
            return `${key}=${value}`;
          }
          return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
        });
        return parts.join('&');
      };

      const [followerSettled, pageSettled, shareSettled] =
        await Promise.allSettled([
          firstValueFrom(
            this.http.get(followerUrl, {
              headers,
              httpsAgent: this.httpsAgent,
              params: {
                q: 'organizationalEntity',
                organizationalEntity: orgUrn,
              },
              paramsSerializer: (params) =>
                new URLSearchParams(params).toString(),
            }),
          ),
          firstValueFrom(
            this.http.get(pageUrl, {
              headers,
              httpsAgent: this.httpsAgent,
              params: {
                q: 'organization',
                organization: orgUrn,
                timeIntervals: timeIntervalsParam,
              },
              paramsSerializer: linkedinSerializer,
            }),
          ),
          firstValueFrom(
            this.http.get(shareUrl, {
              headers,
              httpsAgent: this.httpsAgent,
              params: {
                q: 'organizationalEntity',
                organizationalEntity: orgUrn,
                timeIntervals: timeIntervalsParam,
              },
              paramsSerializer: linkedinSerializer,
            }),
          ),
        ]);

      const getResult = (result) =>
        result.status === 'fulfilled' ? result.value : null;

      const followerRes = getResult(followerSettled);
      const pageRes = getResult(pageSettled);
      const shareRes = getResult(shareSettled);

      // --- Parse Followers ---
      // If followerRes is null (rejected), this safely falls back to {}
      const followerData = followerRes?.data?.elements?.[0] ?? {};

      // --- 1. Total Followers (Summed from Geo for accuracy) ---
      const totalFollowers =
        followerData?.followerCountsByGeoCountry?.reduce(
          (acc: number, curr: any) =>
            acc + (curr.followerCounts?.organicFollowerCount ?? 0),
          0,
        ) ?? 0;

      // --- 2. Profile Page Stats ---
      const pageElements: any[] = pageRes?.data?.elements ?? [];
      let profileViews = 0;
      let profileClicks = 0;

      for (const el of pageElements) {
        const stats = el.totalPageStatistics;
        profileViews += stats?.views?.allPageViews?.uniquePageViews ?? 0;

        // Sum "Custom Button" clicks (the primary CTA on a LinkedIn Page)
        const buttonClicks = [
          ...(stats?.clicks?.mobileCustomButtonClickCounts ?? []),
          ...(stats?.clicks?.desktopCustomButtonClickCounts ?? []),
        ].reduce((sum, item) => sum + (item.clicks ?? 0), 0);

        profileClicks += buttonClicks;
      }

      // --- 3. Share/Engagement Stats ---
      const shareEls: any[] = shareRes?.data?.elements ?? [];
      let impressions = 0,
        postClicks = 0,
        reactions = 0,
        comments = 0,
        shares = 0,
        reach = 0;

      for (const el of shareEls) {
        const s = el?.totalShareStatistics ?? {};
        impressions += s?.impressionCount ?? 0;
        postClicks += s?.clickCount ?? 0;
        reactions += s?.likeCount ?? 0;
        comments += s?.commentCount ?? 0;
        shares += s?.shareCount ?? 0;
        reach += s?.uniqueImpressionsCount ?? 0;
      }

      const engagementCount = postClicks + reactions + comments + shares;

      // --- 4. Clean Demographics (with name resolution) ---
      const demographics = {
        seniority: (followerData?.followerCountsBySeniority ?? []).map(
          (s: any) => ({
            name: this.resolveUrn(s.seniority),
            count: s.followerCounts.organicFollowerCount,
          }),
        ),
        industry: (followerData?.followerCountsByIndustry ?? []).map(
          (i: any) => ({
            name: this.resolveUrn(i.industry),
            count: i.followerCounts.organicFollowerCount,
          }),
        ),
        function: (followerData?.followerCountsByFunction ?? []).map(
          (f: any) => ({
            name: this.resolveUrn(f.function),
            count: f.followerCounts.organicFollowerCount,
          }),
        ),
        region: (followerData?.followerCountsByGeo ?? []).map((g: any) => ({
          name: g.geo, // Geo names usually require a separate /geo endpoint call
          count: g.followerCounts.organicFollowerCount,
        })),
      };

      const obj = {
        platformId: orgUrn,
        fetchedAt: new Date(),
        followersCount: totalFollowers,

        profileViews,
        clicks: profileClicks,

        impressionsCount: impressions,
        engagementCount,
        reach: reach,

        demographics,
      };

      return {
        platformId: orgUrn,
        fetchedAt: new Date(),
        followersCount: totalFollowers,

        profileViews,
        clicks: profileClicks,

        impressionsCount: impressions,
        engagementCount,
        reach: undefined,

        demographics,
      };
    } catch (error) {
      console.log(error);
      this.logger.error(`LinkedIn Account Stats Failed: ${error.message}`);
      this.logger.error(
        'LinkedIn error body:',
        JSON.stringify(error?.response?.data),
      );
      throw error;
    }
  }

  private async getPersonalProfileStats(
    personUrn: string,
    token: string,
  ): Promise<AccountMetrics> {
    try {
      const [followersRes, totals] = await Promise.all([
        firstValueFrom(
          this.http.get(`${this.baseUrl}/memberFollowersCount?q=me`, {
            headers: this.headers(token),
          }),
        ),
        this.getMemberAccountTotals(token),
      ]);

      const followers =
        followersRes?.data?.elements?.[0]?.memberFollowersCount ?? 0;
      const { impressions, reached, reactions, comments, reshares } = totals;

      return {
        platformId: personUrn,
        fetchedAt: new Date(),
        followersCount: followers,
        impressionsCount: impressions || 0,
        reach: reached || 0,
        engagementCount: reactions + comments + reshares || 0,

        profileViews: undefined,
        clicks: undefined,
        demographics: null,
      };
    } catch (e: any) {
      console.log(e);
      this.logger.warn(`LinkedIn memberFollowersCount failed: ${e.message}`);
      throw e;
    }

    // If none worked, return “not available”
    return {
      platformId: personUrn,
      followersCount: undefined,
      fetchedAt: new Date(),
      impressionsCount: undefined,
      profileViews: undefined,
    };
  }

  async getPostStats(
    postIds: string[],
    credentials: AuthCredentials,
    context?: { pageId?: string },
  ): Promise<PostMetrics[]> {
    const token = credentials.accessToken;
    if (postIds.length === 0) return [];
    // Ensure all post IDs are URNs (shares or ugcPosts)
   const postUrns = postIds.map((id) => id.trim());

    const isOrganizationContext =
      context?.pageId && context.pageId.includes('organization');
    // 1. Check if we are dealing with a Company Page or Personal Profile
    // We assume if 'context.pageId' is provided, it's a Company Page.
    if (isOrganizationContext) {
      const orgUrn = this.ensureUrn(context.pageId!);
      return this.fetchCompanyPageStats(orgUrn, token, postUrns);
    } else {
      // Fallback to Personal Profile logic
      return [];
    }
  }

async fetchCompanyPageStats(
  orgUrn: string,
  token: string,
  postUrns: string[],
): Promise<PostMetrics[]> {
  if (!postUrns?.length) return [];

  const url = `${this.baseUrl}/organizationalEntityShareStatistics`;
  const headers = this.headers(token);

  // It handles repeated keys (ugcPosts=...&ugcPosts=...)
const linkedinBatchSerializer = (params: any) => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      // Corrected: Wraps in List() and joins with commas
      const listString = `List(${value.map(v => encodeURIComponent(v)).join(',')})`;
      parts.push(`${key}=${listString}`);
    } else {
      parts.push(`${key}=${encodeURIComponent(value as string)}`);
    }
  }
  return parts.join('&');
};

  const chunks = this.chunkArray(postUrns, 20);
  const out: PostMetrics[] = [];

  for (const chunk of chunks) {
    const ugcPosts = chunk.filter(urn => urn.includes('ugcPost'));
    const shares = chunk.filter(urn => urn.includes('share'));

    const params: Record<string, any> = {
      q: 'organizationalEntity',
      organizationalEntity: orgUrn,
    };

    // In 2026 version, we use the array directly (no [0] indices)
    if (ugcPosts.length > 0) params.ugcPosts = ugcPosts;
    if (shares.length > 0) params.shares = shares;

    try {
      const { data } = await firstValueFrom(
        this.http.get(url, { 
          headers, 
          params, 
          paramsSerializer: linkedinBatchSerializer 
        }),
      );
      
      out.push(...this.mapShareStatsElements(data?.elements ?? []));
    } catch (e: any) {
      console.log(e)
      this.logger.error(`LinkedIn Batch Failed: ${e?.response?.data?.message || e.message}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}


  async getMemberAccountTotals(token: string): Promise<{
    impressions: number;
    reactions: number;
    comments: number;
    reshares: number;
    reached: number;
  }> {
    const url = `${this.baseUrl}/memberCreatorPostAnalytics`;
    const headers = this.headers(token);

    // yesterday window
    const todayStart = DateTime.utc().startOf('day');
    const from = todayStart.minus({ days: 1 });
    const to = todayStart;

    const dateRange = `(start:(day:${from.day},month:${from.month},year:${from.year}),end:(day:${to.day},month:${to.month},year:${to.year}))`;

    const fetch = async (
      queryType: 'IMPRESSION' | 'REACTION' | 'COMMENT' | 'RESHARE',
      aggregation: 'DAILY' | 'TOTAL',
    ) => {
      const { data } = await firstValueFrom(
        this.http.get(url, {
          headers,
          params: { q: 'me', queryType, aggregation, dateRange },
        }),
      );
      const els: any[] = data?.elements ?? [];
      return aggregation === 'DAILY'
        ? els.reduce((s, e) => s + (e?.count ?? 0), 0)
        : (els?.[0]?.count ?? 0);
    };

    // MEMBERS_REACHED must be TOTAL
    const [impressions, reactions, comments, reshares, reached] =
      await Promise.all([
        fetch('IMPRESSION', 'DAILY'),
        fetch('REACTION', 'DAILY'),
        fetch('COMMENT', 'DAILY'),
        fetch('RESHARE', 'DAILY'),
        (async () => {
          const { data } = await firstValueFrom(
            this.http.get(url, {
              headers,
              params: {
                q: 'me',
                queryType: 'MEMBERS_REACHED',
                aggregation: 'TOTAL',
                dateRange,
              },
            }),
          );
          return data?.elements?.[0]?.count ?? 0;
        })(),
      ]);

    return { impressions, reactions, comments, reshares, reached };
  }

  protected chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private ensureUrn(id: string): string {
    if (id.startsWith('urn:li:')) {
      return id;
    }
    // If it's just a raw ID, we assume it's a person based on your storage logic
    return `urn:li:person:${id}`;
  }

private mapShareStatsElements(elements: any[]): PostMetrics[] {
  return elements.map((el) => {
    const s = el.totalShareStatistics ?? {};

    const postId = el.ugcPost || el.share || el.organizationalEntity;

    const clicks = s.clickCount ?? 0;
    const likes = s.likeCount ?? 0;
    const comments = s.commentCount ?? 0;
    const shares = s.shareCount ?? 0;
    
    return {
      postId,
      impressions: s.impressionCount ?? 0,
      reach: s.uniqueImpressionsCount ?? 0,
      clicks,
      likes,
      comments,
      shares,
      engagement: clicks + likes + comments + shares,
      videoViews: s.videoViews ?? undefined, 
      saves: undefined,
    };
  });
}

  /**
   * Returns a clean time range for "Yesterday".
   * - Aligns to 00:00:00 (Midnight) to prevent partial data.
   * - Returns both Date objects (for LinkedIn) and Unix Seconds (for FB/IG).
   */
  getAnalyticsWindow() {
    // 1. Get "Now" in UTC and snap to the start of today (Midnight 00:00:00)
    const today = DateTime.utc().startOf('day');

    // 2. Calculate previous days
    const yesterday = today.minus({ days: 1 });
    const twoDaysAgo = today.minus({ days: 2 });

    return {
      period: {
        from: yesterday.toMillis(),
        to: today.toMillis(),
      },
    };
  }

  private resolveUrn(urn: string): string {
    const mappings: Record<string, string> = {
      // Seniorities
      'urn:li:seniority:1': 'Intern',
      'urn:li:seniority:2': 'Entry Level',
      'urn:li:seniority:3': 'Associate',
      'urn:li:seniority:4': 'Mid-Senior Level',
      'urn:li:seniority:5': 'Director',
      'urn:li:seniority:6': 'Executive',
      'urn:li:seniority:7': 'VP',
      'urn:li:seniority:8': 'Owner',
      'urn:li:seniority:9': 'Partner',

      // Common Functions
      'urn:li:function:1': 'Accounting',
      'urn:li:function:4': 'Business Development',
      'urn:li:function:8': 'Engineering',
      'urn:li:function:13': 'Information Technology',
      'urn:li:function:17': 'Marketing',
      'urn:li:function:20': 'Sales',
      'urn:li:function:25': 'Human Resources',

      // Industries (These vary widely, but here are common ones)
      'urn:li:industry:4': 'Software Development',
      'urn:li:industry:6': 'Technology, Information and Internet',
      'urn:li:industry:96': 'IT Services and IT Consulting',
      'urn:li:industry:137': 'Staffing and Recruiting',
    };

    if (!urn) return 'Unknown';
    return mappings[urn] ?? urn.split(':').pop() ?? urn;
  }
}
