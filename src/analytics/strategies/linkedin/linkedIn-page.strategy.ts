import { PageAnalyticsStrategy } from '@/analytics/interfaces/analytics.interface';
import { PageMetrics } from '@/analytics/interfaces/page-metrics.interface';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class LinkedinPageStrategy implements PageAnalyticsStrategy {
  private readonly logger = new Logger(LinkedinPageStrategy.name);
  private readonly BASE_URL = 'https://api.linkedin.com/v2';

  constructor(private readonly httpService: HttpService) {}

  async getPageStats(account: any): Promise<PageMetrics> {
    const accessToken = account.accessToken;
    // providerId should be "urn:li:organization:12345"
    const orgUrn = account.providerId;

    try {
      // 1. Fetch Follower Count (Network Size)
      // Endpoint: /networkSizes/{urn}?edgeType=CompanyFollowedByMember
      const followerUrl = `${this.BASE_URL}/networkSizes/${encodeURIComponent(orgUrn)}?edgeType=CompanyFollowedByMember`;

      const followerRes = await firstValueFrom(
        this.httpService.get(followerUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );

      // 2. Fetch Page Statistics (Impressions/Views) - Last 24h
      // Endpoint: /organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity={urn}
      // This gives lifetime or time-bound stats.
      // For MVP, "Followers" is the most stable metric.
      // Detailed Page Views require the "Organization Page Statistics" API which is complex.

      const sizeData = followerRes.data;

      return {
        followers: sizeData.firstDegreeSize || 0,
        following: 0, // Companies don't "follow" in the same way
        postCount: 0,

        // These would require a second, more complex call to organizationalEntityPageStatistics
        pageImpressions: 0,
        profileViews: 0,
      };
    } catch (error) {
      const msg = error.response?.data?.message || error.message;
      this.logger.error(`Failed LinkedIn Page stats for ${orgUrn}: ${msg}`);
      throw error;
    }
  }
}
