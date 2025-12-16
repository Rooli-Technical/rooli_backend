import { PageAnalyticsStrategy } from '@/analytics/interfaces/analytics.interface';
import { PageMetrics } from '@/analytics/interfaces/page-metrics.interface';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class FacebookPageStrategy implements PageAnalyticsStrategy {
  private readonly logger = new Logger(FacebookPageStrategy.name);
  private readonly GRAPH_URL = 'https://graph.facebook.com/v23.0';

  constructor(private readonly httpService: HttpService) {}

  async getPageStats(account: any): Promise<PageMetrics> {
    const accessToken = account.accessToken;
    const pageId = account.providerId;

    try {
      //  Fetch "Live" Snapshot (Followers)
      const pageProfileUrl = `${this.GRAPH_URL}/${pageId}?fields=fan_count,followers_count&access_token=${accessToken}`;

      const profileRes = await firstValueFrom(
        this.httpService.get(pageProfileUrl),
      );

      //  Fetch "Activity" Insights
      const metricsList = [
        'page_impressions',
        'page_views_total',
        'page_website_clicks_logged_in_unique',
      ].join(',');

      const insightsUrl = `${this.GRAPH_URL}/${pageId}/insights?metric=${metricsList}&period=day&access_token=${accessToken}`;

      const insightsRes = await firstValueFrom(
        this.httpService.get(insightsUrl),
      );

      // Extraction Helper
      const getInsightValue = (metricName: string): number => {
        const item = insightsRes.data.data.find(
          (i: any) => i.name === metricName,
        );
        const latestValue = item?.values?.slice(-1)[0];
        return latestValue?.value || 0;
      };

      return {
        followers:
          profileRes.data.followers_count || profileRes.data.fan_count || 0,
        following: 0,
        postCount: 0,
        pageImpressions: getInsightValue('page_impressions'),
        profileViews: getInsightValue('page_views_total'),
        websiteClicks: getInsightValue('page_website_clicks_logged_in_unique'),
      };
    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      this.logger.error(`Failed FB Page stats for ${pageId}: ${msg}`);
      throw error;
    }
  }
}
