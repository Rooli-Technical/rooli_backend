import { AnalyticsStrategy } from "@/analytics/interfaces/analytics.interface";
import { PostMetrics } from "@/analytics/interfaces/post-metrics.interface";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { firstValueFrom } from "rxjs";

@Injectable()
export class LinkedinPostStrategy implements AnalyticsStrategy {
  private readonly logger = new Logger(LinkedinPostStrategy.name);
  private readonly BASE_URL = 'https://api.linkedin.com/v2';

  constructor(private readonly httpService: HttpService) {}

  async getMetrics(account: any, postIds: string[]): Promise<Record<string, PostMetrics>> {
    const result: Record<string, PostMetrics> = {};
    const accessToken = account.accessToken;

    const promises = postIds.map(async (postId) => {
      
      try {
        // 1. Fetch Social Actions (Likes, Comments)
        const actionsUrl = `${this.BASE_URL}/socialActions/${encodeURIComponent(postId)}`;
        
        const actionsRes = await firstValueFrom(
            this.httpService.get(actionsUrl, {
                headers: { Authorization: `Bearer ${accessToken}` }
            })
        );

        // 2. Fetch Impressions/Clicks (Requires Organizational Access)
        // Endpoint: /organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity={orgUrn}&shares=List({shareUrn})
        // NOTE: This complex query is often skipped in MVPs due to complexity. 
        // We will stick to the basic Social Actions which works for both Personal & Org posts.

        const data = actionsRes.data;

        result[postId] = {
          likes: data.likesSummary?.totalLikes || 0,
          comments: data.commentsSummary?.totalComments || 0,
          shares: 0, // LinkedIn API v2 often hides share counts in standard endpoints
          impressions: 0, // Impressions usually require the separate Analytics API
          clicks: 0,
          
          // LinkedIn Specifics could go into metaMetrics JSON if needed
          // e.g. "applauds", "interests" (Reaction types)
        };

      } catch (error) {
        // LinkedIn 404s if the post was deleted or is too old
        const status = error.response?.status;
        this.logger.warn(`Failed LinkedIn Post ${postId} (Status: ${status})`);
      }
    });

    await Promise.all(promises);
    return result;
  }
}