import { AnalyticsStrategy } from "@/analytics/interfaces/analytics.interface";
import { PostMetrics } from "@/analytics/interfaces/post-metrics.interface";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { firstValueFrom } from "rxjs";

@Injectable()
export class InstagramPostStrategy implements AnalyticsStrategy {
  private readonly logger = new Logger(InstagramPostStrategy.name);
  private readonly GRAPH_URL = 'https://graph.facebook.com/v23.0';

  constructor(private readonly httpService: HttpService) {}

  async getMetrics(account: any, postIds: string[]): Promise<Record<string, PostMetrics>> {
    const result: Record<string, PostMetrics> = {};
    const accessToken = account.accessToken;

    //  Define Fields
    // - like_count, comments_count: Standard public metrics
    // - insights.metric(...): Private business metrics
    //   'total_interactions' = likes + comments + saves
    const fields = [
      'like_count',
      'comments_count',
      'media_product_type', // REELS, FEED, STORY
      'insights.metric(impressions,reach,saved,total_interactions)'
    ].join(',');

    // Parallel Execution
    const promises = postIds.map(async (postId) => {
      try {
        const url = `${this.GRAPH_URL}/${postId}?fields=${fields}&access_token=${accessToken}`;
        
        const { data } = await firstValueFrom(
            this.httpService.get(url)
        );

        //  Helper for Insights (Same pattern as Facebook)
        const getInsightValue = (metricName: string): number => {
          const insightsData = data.insights?.data || [];
          const metric = insightsData.find((m: any) => m.name === metricName);
          return metric?.values?.[0]?.value || 0;
        };

        result[postId] = {
          likes: data.like_count || 0,
          comments: data.comments_count || 0,
          shares: 0, // IG API does not provide share counts for privacy reasons
          
          // Private
          impressions: getInsightValue('impressions'),
          reach: getInsightValue('reach'),
          saves: getInsightValue('saved'),
          
          // Interaction Calculation (Optional but useful)
          // engagementRate can be calculated later: (total_interactions / reach) * 100
        };

      } catch (error) {
        // IG specific error: Media ID might be invalid if user deleted post
        const msg = error.response?.data?.error?.message || error.message;
        this.logger.warn(`Failed IG Post ${postId}: ${msg}`);
      }
    });

    await Promise.all(promises);
    return result;
  }
}