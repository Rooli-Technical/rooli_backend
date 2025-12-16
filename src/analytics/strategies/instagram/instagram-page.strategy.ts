import { PageAnalyticsStrategy } from "@/analytics/interfaces/analytics.interface";
import { PageMetrics } from "@/analytics/interfaces/page-metrics.interface";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { firstValueFrom } from "rxjs";

@Injectable()
export class InstagramPageStrategy implements PageAnalyticsStrategy {
  private readonly logger = new Logger(InstagramPageStrategy.name);
  private readonly GRAPH_URL = 'https://graph.facebook.com/v23.0';

  constructor(private readonly httpService: HttpService) {}

  async getPageStats(account: any): Promise<PageMetrics> {
    const accessToken = account.accessToken;
    const igUserId = account.igBussinessId; 

    try {
      //  Fetch Snapshot (Followers & Count)
      const profileUrl = `${this.GRAPH_URL}/${igUserId}?fields=followers_count,follows_count,media_count&access_token=${accessToken}`;
      
      const profileRes = await firstValueFrom(
        this.httpService.get(profileUrl)
      );

      // Fetch Activity Insights (Traffic)
      // 'impressions', 'reach' are account-wide for the period
      // 'profile_views' shows how many people visited the grid
      const metricsList = [
        'impressions',
        'reach',
        'profile_views',
        'website_clicks'
      ].join(',');

      const insightsUrl = `${this.GRAPH_URL}/${igUserId}/insights?metric=${metricsList}&period=day&access_token=${accessToken}`;

      const insightsRes = await firstValueFrom(
        this.httpService.get(insightsUrl)
      );

      //  Extraction Helper
      const getInsightValue = (metricName: string): number => {
        const item = insightsRes.data.data.find((i: any) => i.name === metricName);
        // Grab the latest complete day (usually last item in array)
        const latestValue = item?.values?.slice(-1)[0];
        return latestValue?.value || 0;
      };

      return {
        // Snapshot
        followers: profileRes.data.followers_count || 0,
        following: profileRes.data.follows_count || 0,
        postCount: profileRes.data.media_count || 0,

        // Activity (Last 24h)
        pageImpressions: getInsightValue('impressions'),
        profileViews: getInsightValue('profile_views'),
        websiteClicks: getInsightValue('website_clicks')
      };

    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      this.logger.error(`Failed IG Page stats for ${igUserId}: ${msg}`);
      throw error;
    }
  }
}