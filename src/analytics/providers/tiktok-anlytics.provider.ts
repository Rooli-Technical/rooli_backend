import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { IAnalyticsProvider, AuthCredentials, FetchAccountResult, FetchPostResult } from '../interfaces/analytics-provider.interface';

@Injectable()
export class TikTokAnalyticsProvider implements IAnalyticsProvider {
  private readonly logger = new Logger(TikTokAnalyticsProvider.name);
  private readonly API_URL = 'https://open.tiktokapis.com/v2';

  constructor(
    private readonly config: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  /**
   * TIKTOK ACCOUNT STATS
   * Fetches total followers, following, total lifetime likes, and video count.
   */
  async getAccountStats(
    profileId: string, 
    credentials: AuthCredentials,
  ): Promise<FetchAccountResult> {
    const token = credentials.accessToken;

    try {
      const { data } = await firstValueFrom(
        this.httpService.get(`${this.API_URL}/user/info/`, {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            // Note: TikTok strictly requires these fields to be requested explicitly
            fields: 'open_id,follower_count,following_count,likes_count,video_count',
          },
        }),
      );

      // TikTok v2 wraps successful data, and uses 'ok' or 0 for success
      if (data.error?.code !== 'ok' && data.error?.code !== 0) {
        throw new Error(data.error?.message || 'Failed to fetch TikTok stats');
      }

      const user = data.data.user;

      return {
        platformId: user.open_id || profileId,
        fetchedAt: new Date(),
        unified: {
          followersTotal: user.follower_count ?? 0,
          impressions: 0, // TikTok doesn't provide account-level aggregate views
          reach: 0,
          profileViews: 0,
          clicks: 0,
          engagementCount: user.likes_count ?? 0, // Total lifetime likes on the account
        },
        specific: {
          followingCount: user.following_count ?? 0,
          videoCount: user.video_count ?? 0,
        },
      };
    } catch (error: any) {
      this.logger.error(`[TikTok Account Stats] Failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * TIKTOK POST (VIDEO) STATS
   * Fetches views, likes, comments, and shares for specific videos.
   */
  async getPostStats(
    postIds: string[],
    credentials: AuthCredentials,
  ): Promise<FetchPostResult[]> {
    if (postIds.length === 0) return [];
    const token = credentials.accessToken;

    // TikTok recommends batching video queries (usually max 20 per request)
    const chunks = this.chunkArray(postIds, 20);
    const results: FetchPostResult[] = [];

    for (const chunk of chunks) {
      try {
        const { data } = await firstValueFrom(
          this.httpService.post(
            `${this.API_URL}/video/query/`,
            {
              filters: { video_ids: chunk },
            },
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              params: {
                // Requesting the specific metrics
                fields: 'id,title,like_count,comment_count,share_count,view_count',
              },
            },
          ),
        );

        if (data.error?.code !== 'ok' && data.error?.code !== 0) {
          this.logger.error(`TikTok video query batch failed: ${data.error?.message}`);
          continue;
        }

        const videos = data.data?.videos || [];

        const mapped = videos.map((video: any) => {
          const views = video.view_count ?? 0;
          const likes = video.like_count ?? 0;
          const comments = video.comment_count ?? 0;
          const shares = video.share_count ?? 0;

          return {
            unified: {
              postId: video.id,
              impressions: views,
              reach: views, // TikTok treats views as reach
              likes: likes,
              comments: comments,
              engagementCount: likes + comments + shares,
            },
            specific: {
              shares: shares,
              videoViews: views,
              title: video.title,
            },
          };
        });

        results.push(...mapped);
      } catch (error: any) {
         console.log(error);
        this.logger.error(`[TikTok Post Stats] Batch chunk failed: ${error.message}`);
      }
    }

    return results;
  }

  protected chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}