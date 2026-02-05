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
import * as https from 'https';

@Injectable()
export class InstagramAnalyticsProvider implements IAnalyticsProvider {
  private readonly logger = new Logger(InstagramAnalyticsProvider.name);
  private readonly baseUrl = 'https://graph.facebook.com/v22.0';

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
   * INSTAGRAM ACCOUNT STATS
   * Note: We fetch the IG User ID, not the Facebook Page ID.
   */
  async getAccountStats(
    igUserId: string,
    credentials: AuthCredentials,
  ): Promise<AccountMetrics> {
    try {
      const token = credentials.accessToken;

      const dailyParams = {
        access_token: token,
        metric: 'reach,views,total_interactions,profile_links_taps',
        period: 'day',
        metric_type: 'total_value',
      };

      const dailyUrl = `${this.baseUrl}/${igUserId}/insights`;
      const userUrl = `${this.baseUrl}/${igUserId}`;

      const userParams = {
        access_token: token,
        fields: 'followers_count',
      };

      const [userRes, insightsRes, demographicsData] = await Promise.all([
        firstValueFrom(
          this.httpService.get(userUrl, {
            params: userParams,
            httpsAgent: this.httpsAgent,
          }),
        ),
        firstValueFrom(
          this.httpService.get(dailyUrl, {
            params: dailyParams,
            httpsAgent: this.httpsAgent,
          }),
        ),
        this.getDemographics(igUserId, token),
      ]);

      const insights = insightsRes.data?.data || [];

      // Update getMetric to handle total_value correctly
      const getMetric = (name: string) => {
        const metric = insights.find((i: any) => i.name === name);
        if (!metric) return 0;

        if (metric.total_value) {
          return metric.total_value.value ?? 0;
        }
        // Fallback for standard time-series
        return metric.values?.[0]?.value ?? 0;
      };

      return {
        platformId: igUserId,
        followersCount: userRes.data?.followers_count ?? 0,
        impressionsCount: getMetric('views'),
        reach: getMetric('reach'),
        engagementCount: getMetric('total_interactions'),
        clicks: getMetric('profile_links_taps'),
        profileViews: getMetric('profile_links_taps'),
        demographics: demographicsData ?? {},
        fetchedAt: new Date(),
      };
    } catch (error) {
      console.log(error);
      this.logger.error(`IG Account fetch failed for ${igUserId}`, error);
      throw error;
    }
  }

  /**
   * INSTAGRAM MEDIA STATS (BATCHED)
   * Handles Images, Videos, and Reels (if media_product_type is requested).
   */
  async getPostStats(
    mediaIds: string[],
    credentials: AuthCredentials,
  ): Promise<PostMetrics[]> {
    const token = credentials.accessToken;
    if (mediaIds.length === 0) return [];
    const chunks = this.chunkArray(mediaIds, 50);
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const publicFields =
            'id,like_count,comments_count,media_type,media_product_type';
          const insightMetrics = 'views,reach,saved,shares,total_interactions';
          const url = `${this.baseUrl}/`;

          const { data } = await firstValueFrom(
            this.httpService.get(url, {
              params: {
                access_token: token,
                ids: chunk.join(','),
                fields: `${publicFields},insights.metric(${insightMetrics}).metric_type(total_value)`,
              },
              httpsAgent: this.httpsAgent,
            }),
          );

          return Object.values(data).map((media: any) => {
            const insights = media.insights?.data || [];

            const getInsight = (name: string) => {
              const metric = insights.find((i: any) => i.name === name);
              if (!metric) return 0;

              // Try total_value
              if (
                metric.total_value &&
                typeof metric.total_value === 'object'
              ) {
                return metric.total_value.value ?? 0;
              }

              //  Try values array
              if (Array.isArray(metric.values) && metric.values.length > 0) {
                return metric.values[0]?.value ?? 0;
              }

              return 0;
            };

            return {
              postId: media.id,
              impressions: getInsight('views'),
              reach: getInsight('reach'),
              likes: media.like_count || 0,
              comments: media.comments_count || 0,
              shares: getInsight('shares'),
              saves: getInsight('saved'),
              engagement: getInsight('total_interactions'),
              clicks: 0,
              videoViews:
                media.media_type === 'VIDEO' ? getInsight('views') : 0,
            };
          });
        } catch (error) {
          console.log(error);
          // Tip: If one chunk fails (e.g., due to a deleted post), log it but don't crash the whole job
          this.logger.error(`Instagram Chunk Failed: ${error.message}`);
          return [];
        }
      }),
    );

    return results.flat();
  }

  private async getDemographics(igUserId: string, token: string) {
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/${igUserId}/insights`, {
          params: {
            access_token: token,
            metric:
              'audience_city,audience_country,audience_gender_age,audience_locale',
            period: 'lifetime',
          },
          httpsAgent: this.httpsAgent,
        }),
      );

      const data = res.data?.data || [];

      return {
        city:
          data.find((m: any) => m.name === 'audience_city')?.values?.[0]
            ?.value || {},
        country:
          data.find((m: any) => m.name === 'audience_country')?.values?.[0]
            ?.value || {},
        genderAge:
          data.find((m: any) => m.name === 'audience_gender_age')?.values?.[0]
            ?.value || {},
        locale:
          data.find((m: any) => m.name === 'audience_locale')?.values?.[0]
            ?.value || {},
      };
    } catch (e: any) {
      // Log the error for debugging, but return null so the main fetch doesn't crash
      this.logger.warn(
        `Demographics fetch skipped for ${igUserId}: ${e.message}`,
      );
      return null;
    }
  }

  protected chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
