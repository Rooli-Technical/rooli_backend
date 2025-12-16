import { AuthContext, PageAnalyticsStrategy } from "@/analytics/interfaces/analytics.interface";
import { PageMetrics } from "@/analytics/interfaces/page-metrics.interface";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { firstValueFrom } from "rxjs";

@Injectable()
export class TwitterPageStrategy implements PageAnalyticsStrategy {
  private readonly logger = new Logger(TwitterPageStrategy.name);
  private readonly BASE_URL = 'https://api.twitter.com/2/users';

  constructor(private readonly httpService: HttpService) {}

  async getPageStats(context: AuthContext): Promise<PageMetrics> {
     const accessToken = context.accessToken;
    const userId = context.platformAccountId;

    try {
      // Endpoint: GET /2/users/:id?user.fields=public_metrics
      const url = `${this.BASE_URL}/${userId}?user.fields=public_metrics`;

      const { data: responseData } = await firstValueFrom(
        this.httpService.get(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
      );

      const user = responseData.data;
      const m = user.public_metrics;

      return {
        followers: m.followers_count || 0,
        following: m.following_count || 0,
        postCount: m.tweet_count || 0,
        
        // Twitter API Basic Tier does not provide "Profile Views" 
        // in the standard User Object.
        profileViews: 0, 
        pageImpressions: 0
      };

    } catch (error) {
      const msg = error.response?.data?.detail || error.message;
      this.logger.error(`Failed Twitter Page stats for ${userId}: ${msg}`);
      throw error;
    }
  }
}