import { AnalyticsStrategy } from "@/analytics/interfaces/analytics.interface";
import { PostMetrics } from "@/analytics/interfaces/post-metrics.interface";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { firstValueFrom } from "rxjs";

@Injectable()
export class TwitterPostStrategy implements AnalyticsStrategy {
  private readonly logger = new Logger(TwitterPostStrategy.name);
  private readonly BASE_URL = 'https://api.twitter.com/2/tweets';

  constructor(private readonly httpService: HttpService) {}

  async getMetrics(account: { accessToken: string }, postIds: string[]): Promise<Record<string, PostMetrics>> {
    const result: Record<string, PostMetrics> = {};
    const accessToken = account.accessToken;

    // Safety: Twitter API v2 limits "ids" parameter to 100 per request.
    // Ensure we don't exceed this even if the queue sends a larger batch.
    const chunks = this.chunkArray(postIds, 100);

    for (const chunk of chunks) {
      try {
        const idsString = chunk.join(',');

        // We request:
        // 1. public_metrics: likes, retweets, quotes, replies
        // 2. non_public_metrics: impressions, url_link_clicks (Only available if using User Token)
        const params = new URLSearchParams({
          ids: idsString,
          'tweet.fields': 'public_metrics,non_public_metrics,organic_metrics', 
        });

        const url = `${this.BASE_URL}?${params.toString()}`;

        const { data: responseData } = await firstValueFrom(
          this.httpService.get(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
        );

        const tweets = responseData.data || [];
        const errors = responseData.errors || [];

        // Log specific errors (e.g., if a single tweet was deleted)
        if (errors.length > 0) {
          this.logger.debug(`Partial Twitter errors: ${JSON.stringify(errors)}`);
        }

        tweets.forEach((tweet: any) => {
            // Priority: Non-Public (most accurate for owner) -> Organic -> Public
            const pub = tweet.public_metrics || {};
            const nonPub = tweet.non_public_metrics || {};
            const organic = tweet.organic_metrics || {};

            result[tweet.id] = {
                // Engagement (Public)
                likes: pub.like_count || 0,
                comments: pub.reply_count || 0,
                shares: (pub.retweet_count || 0) + (pub.quote_count || 0),
                saves: pub.bookmark_count || 0,

                // Impressions/Views (Private)
                // non_public_metrics is only returned for tweets created within the last 30 days
                impressions: nonPub.impression_count || organic.impression_count || pub.impression_count || 0,
                
                // Clicks
                clicks: nonPub.url_link_clicks || organic.url_link_clicks || 0,
            };
        });

      } catch (error) {
        const msg = error.response?.data?.detail || error.message;
        this.logger.error(`Failed Twitter Batch: ${msg}`);
        // We continue to the next chunk instead of crashing everything
      }
    }

    return result;
  }

  // Helper to slice array into chunks of 100
  private chunkArray(array: string[], size: number): string[][] {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
      result.push(array.slice(i, i + size));
    }
    return result;
  }
}