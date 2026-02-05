import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import {
  AccountMetrics,
  AuthCredentials,
  IAnalyticsProvider,
  PostMetrics,
} from '../interfaces/analytics-provider.interface';
import { DateTime } from 'luxon';
import * as https from 'https';

@Injectable()
export class FacebookAnalyticsProvider implements IAnalyticsProvider {
  private readonly logger = new Logger(FacebookAnalyticsProvider.name);
  private readonly baseUrl = 'https://graph.facebook.com/v23.0';
  private readonly BATCH_LIMIT = 50;
  

  constructor(
    private readonly config: ConfigService,
    private readonly httpService: HttpService,
  ) {}

    private httpsAgent = new https.Agent({
      family: 4, // Force IPv4 (Disable IPv6)
      keepAlive: true,
      timeout: 30000,
    });

  /**
   * PAGE STATS
   * Fetches total followers and page-level impressions/views.
   */
  async getAccountStats(
    pageId: string,
    credentials: AuthCredentials,
  ): Promise<AccountMetrics> {
    const token = credentials.accessToken;
    const { fbSince, fbUntil } = this.getAnalyticsWindow();

    try {
      // Parallel Fetching: Get Metadata & Daily Insights
      const [pageRes, insightsRes, demographicsData] = await Promise.all([
        // A. Metadata
        firstValueFrom(
          this.httpService.get(`${this.baseUrl}/${pageId}`, {
            params: {
              access_token: token,
              fields: 'followers_count,fan_count',
            },
          }),
        ),
        // B. Daily Stats
        firstValueFrom(
          this.httpService.get(`${this.baseUrl}/${pageId}/insights`, {
            params: {
              access_token: token,
              metric:
                'page_media_view,page_impressions_unique,page_post_engagements,page_total_actions',
              period: 'day',
              fbSince,
              fbUntil,
            },
            httpsAgent: this.httpsAgent,
          }),
        ),
        // C. Demographics (Helper function)
        this.getDemographics(pageId, token),
      ]);

      // Process Daily Insights
      const insights = insightsRes.data?.data ?? [];

      const getVal = (name: string) => {
        const insight = insights.find((m: any) => m.name === name);
        const values = insight?.values ?? [];
        if (values.length === 0) return 0;

        // Get the most recent value (last in the array)
        return values[values.length - 1]?.value ?? 0;
      };

      return {
        platformId: pageId,
        fetchedAt: new Date(),
        followersCount:
          pageRes.data.followers_count ?? pageRes.data.fan_count ?? 0,
        impressionsCount: getVal('page_media_view'),
        reach: getVal('page_impressions_unique'),
        engagementCount: getVal('page_post_engagements'),
        clicks: getVal('page_total_actions'),
        demographics: demographicsData ?? {},
      };
    } catch (error: any) {
      const msg = error.response?.data?.error?.message || error.message;
      this.logger.error(`[Facebook Page Stats] Failed for ${pageId}: ${msg}`);
      throw error;
    }
  }

  async getPostStats(
    postIds: string[],
    credentials: AuthCredentials,
  ): Promise<PostMetrics[]> {
    if (postIds.length === 0) return [];

    // Batching in chunks of 50
    const chunks = this.chunkArray(postIds, 50);

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          // 1. Request Summaries with limit(0) to save data
          const publicFields =
            'id,shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)';

          const insightMetrics =
            'post_media_view,post_impressions_unique,post_clicks';

          const url = `${this.baseUrl}/`;

          const { data } = await firstValueFrom(
            this.httpService.get(url, {
              params: {
                access_token: credentials.accessToken,
                ids: chunk.join(','),
                fields: `${publicFields},insights.metric(${insightMetrics})`,
              },
              httpsAgent: this.httpsAgent,
            }),
          );

          // Map the data correctly
          return Object.values(data).map((post: any) => this.mapPostData(post));
        } catch (error) {
          this.logger.error(
            `Facebook Batch Fetch failed for chunk: ${error.message}`,
          );
          return [];
        }
      }),
    );

    return results.flat();
  }

  /**
   * Helper to fetch Demographics safely.
   * Returns null if page has <100 followers (API Restriction).
   */
 private async getDemographics(pageId: string, token: string) {
  try {
    const res = await firstValueFrom(
      this.httpService.get(`${this.baseUrl}/${pageId}/insights`, {
        params: {
          access_token: token,
          metric: 'page_fans_city,page_fans_gender_age,page_fans_country',
          period: 'lifetime',
        },
        httpsAgent: this.httpsAgent,
      }),
    );

    const data = res.data?.data || [];
    if (data.length === 0) return null;

    return {
      city: data.find((m: any) => m.name === 'page_fans_city')?.values?.[0]?.value || {},
      country: data.find((m: any) => m.name === 'page_fans_country')?.values?.[0]?.value || {},
      genderAge: data.find((m: any) => m.name === 'page_fans_gender_age')?.values?.[0]?.value || {},
    };
  } catch (e) {
    return null; 
  }
}

  private mapPostData(post: any): PostMetrics {
    const insights = post.insights?.data || [];
    const getInsight = (name: string) =>
      insights.find((i: any) => i.name === name)?.values?.[0]?.value || 0;
    return {
      postId: post.id,
      impressions: getInsight('post_media_view') || getInsight('post_impressions_unique'),
      reach: getInsight('post_impressions_unique'),
      clicks: getInsight('post_clicks'),
      likes: post.reactions?.summary?.total_count || 0,
      comments: post.comments?.summary?.total_count || 0,
      shares: post.shares?.count || 0,
    };
  }

  protected chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  getAnalyticsWindow() {
    // 1. Get "Now" in UTC and snap to the start of today (Midnight 00:00:00)
    const today = DateTime.utc().startOf('day');

    // 2. Calculate previous days
    const yesterday = today.minus({ days: 1 });
    const twoDaysAgo = today.minus({ days: 2 });

    return {
      // FB "Since": 2 days ago (Safety buffer)
      fbSince: twoDaysAgo.toUnixInteger(),
      // FB "Until": Midnight today
      fbUntil: today.toUnixInteger(),
    };
  }
}
