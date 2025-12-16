import { AnalyticsStrategy } from "@/analytics/interfaces/analytics.interface";
import { PostMetrics } from "@/analytics/interfaces/post-metrics.interface";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { firstValueFrom } from "rxjs";

@Injectable()
export class FacebookPostStrategy implements AnalyticsStrategy {
  private readonly logger = new Logger(FacebookPostStrategy.name);
  private readonly GRAPH_URL = 'https://graph.facebook.com/v23.0';

  // Inject HttpService here
  constructor(private readonly httpService: HttpService) {}

  async getMetrics(account: any, postIds: string[]): Promise<Record<string, PostMetrics>> {
    const result: Record<string, PostMetrics> = {};
    const accessToken = account.accessToken;

    const fields = [
      'shares',
      'likes.summary(true).limit(0)',
      'comments.summary(true).limit(0)',
      'insights.metric(post_impressions,post_impressions_unique,post_clicks,post_video_views)'
    ].join(',');

    const promises = postIds.map(async (postId) => {
      try {
        const url = `${this.GRAPH_URL}/${postId}?fields=${fields}&access_token=${accessToken}`;
        
        const { data } = await firstValueFrom(
            this.httpService.get(url)
        );

        // Helper to extract Insight Values safely
        const getInsightValue = (metricName: string): number => {
          const insightsData = data.insights?.data || [];
          const metric = insightsData.find((m: any) => m.name === metricName);
          return metric?.values?.[0]?.value || 0;
        };

        result[postId] = {
          likes: data.likes?.summary?.total_count || 0,
          comments: data.comments?.summary?.total_count || 0,
          shares: data.shares?.count || 0,
          impressions: getInsightValue('post_impressions'),
          reach: getInsightValue('post_impressions_unique'),
          clicks: getInsightValue('post_clicks'),
          video_views: getInsightValue('post_video_views'), 
        };

      } catch (error) {
        const status = error.response?.status;
        const msg = error.response?.data?.error?.message || error.message;
        this.logger.warn(`Failed FB Post ${postId} (Status: ${status}): ${msg}`);
      }
    });

    await Promise.all(promises);

    return result;
  }
}