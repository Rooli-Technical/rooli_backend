import { PrismaService } from '@/prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { PostMetrics } from '../interfaces/analytics.interface';
import { TwitterApi } from 'twitter-api-v2';
import { EncryptionService } from '@/common/utility/encryption.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AnalyticsPostService {
  private readonly logger = new Logger(AnalyticsPostService.name);
  private readonly META_API_VERSION = 'v23.0';
  private readonly LINKEDIN_API_VERSION = '202501';
  private readonly appKey: string;
  private readonly appSecret: string;

  constructor(
    private prisma: PrismaService,
    private httpService: HttpService,
    private encryptionService: EncryptionService,
    private readonly configService: ConfigService,
  ) {
    this.appKey = this.configService.get<string>('X_API_KEY');
    this.appSecret = this.configService.get<string>('X_API_SECRET');

    if (!this.appKey || !this.appSecret) {
      throw new Error('Twitter API credentials missing in config');
    }
  }

 async fetchMetaMetrics(post: any): Promise<PostMetrics> {
    if (!post.pageAccount?.accessToken) return null;

    const decryptedToken = await this.encryptionService.decrypt(
      post.pageAccount?.accessToken,
    );

    // Distinguish between FB and IG based on your post.platform or account type
    const isInstagram =
      post.platform === 'INSTAGRAM' || post.account.platform === 'INSTAGRAM';

    const url = `https://graph.facebook.com/${this.META_API_VERSION}/${post.platformPostId}`;

    try {
      if (isInstagram) {
        return this.fetchInstagramMetrics(url, decryptedToken);
      } else {
        return this.fetchFacebookMetrics(url, decryptedToken);
      }
    } catch (error) {
      this.logger.error(
        `Meta Metrics Error [${post.platform}]: ${error.message}`,
      );
      return null;
    }
  }

  // Facebook Page Post Logic
 async fetchFacebookMetrics(url: string, token: string) {
    const response = await firstValueFrom(
      this.httpService.get(url, {
        params: {
          access_token: token,
          fields:
            'insights.metric(post_impressions,post_impressions_unique,post_clicks),likes.summary(true),comments.summary(true),shares',
        },
      }),
    );

    const data = response.data;
    const insights = data.insights?.data || [];
    const getVal = (name: string) =>
      insights.find((i) => i.name === name)?.values?.[0]?.value || 0;

    return {
      likes: data.likes?.summary?.total_count || 0,
      comments: data.comments?.summary?.total_count || 0,
      shares: data.shares?.count || 0,
      impressions: getVal('post_impressions'),
      reach: getVal('post_impressions_unique'),
      clicks: getVal('post_clicks'),
    };
  }

  // Instagram Media Logic
 async fetchInstagramMetrics(url: string, token: string) {
    const response = await firstValueFrom(
      this.httpService.get(url, {
        params: {
          access_token: token,
          // IG uses direct fields for counts, and 'insights' for reach/impressions
          // Note: 'shares' is now an insight metric for IG, not a public field
          fields:
            'like_count,comments_count,insights.metric(impressions,reach,shares,total_interactions)',
        },
      }),
    );

    const data = response.data;
    const insights = data.insights?.data || [];
    const getVal = (name: string) =>
      insights.find((i) => i.name === name)?.values?.[0]?.value || 0;

    return {
      likes: data.like_count || 0,
      comments: data.comments_count || 0,

      // IG Shares are private/hidden unless you fetch them via Insights
      shares: getVal('shares') || 0,

      impressions: getVal('impressions'),
      reach: getVal('reach'),

      // 'Clicks' is ambiguous on IG. Usually 'total_interactions' is the closest proxy
      // or you can specificy 'website_clicks' if you want that specifically.
      clicks: 0,
      engagement: getVal('total_interactions'), // IG provides this pre-calculated
    };
  }

 async fetchLinkedInMetrics(post: any): Promise<PostMetrics> {
  try {
    //  Setup Token & URN
    const encryptedToken = post.pageAccount?.accessToken || post.socialAccount?.accessToken;
    if (!encryptedToken) return null;

    const decryptedToken = await this.encryptionService.decrypt(encryptedToken);
    const urn = post.platformPostId; // e.g. "urn:li:share:123"
    
    // --- CALL 1: Engagement (Likes & Comments) ---
    // Works for BOTH Pages and Profiles
    const encodedUrn = encodeURIComponent(urn);
    const socialUrl = `https://api.linkedin.com/rest/socialMetadata/${encodedUrn}`;
    
    const socialRes = await firstValueFrom(
      this.httpService.get(socialUrl, {
        headers: {
          Authorization: `Bearer ${decryptedToken}`,
          'LinkedIn-Version': this.LINKEDIN_API_VERSION,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }),
    ).catch(() => ({ data: {} })); // Fallback if fails

    const summary = socialRes.data.reactionSummaries?.['urn:li:reactionType:LIKE'];
    let metrics = {
      likes: summary?.count || 0,
      comments: socialRes.data.commentSummary?.count || 0,
      shares: 0,
      impressions: 0,
      clicks: 0,
      reach: 0,
    };

    // --- CALL 2: Performance (Impressions, Reach, Shares, Clicks) ---
    // 🛑 ONLY works for Company Pages. 
    // We check if 'post.pageAccount' exists to know if it's a page.
    if (post.pageAccount) {
      const performance = await this.fetchLinkedInPageStats(urn, decryptedToken);
      if (performance) {
        metrics.shares = performance.shareCount;
        metrics.impressions = performance.impressionCount;
        metrics.clicks = performance.clickCount;
        metrics.reach = performance.uniqueImpressionsCount; 
      }
    }

    return metrics;

  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

// === NEW HELPER FUNCTION ===
private async fetchLinkedInPageStats(shareUrn: string, token: string) {
  try {
    // We query the "Share Statistics" endpoint specifically for THIS post URN
    const url = `https://api.linkedin.com/rest/organizationalEntityShareStatistics`;
    
    const response = await firstValueFrom(
      this.httpService.get(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            'LinkedIn-Version': this.LINKEDIN_API_VERSION,
            'X-Restli-Protocol-Version': '2.0.0',
        },
        params: {
            q: 'shares',
            shares: `List(${shareUrn})` // We ask for stats for this specific post
        }
      })
    );

    // The data is inside elements[0].totalShareStatistics
    const stats = response.data.elements?.[0]?.totalShareStatistics;
    
    return {
        shareCount: stats?.shareCount || 0,
        impressionCount: stats?.impressionCount || 0,
        clickCount: stats?.clickCount || 0, // Clicks on content, name, or logo
        uniqueImpressionsCount: stats?.uniqueImpressionsCount || 0
    };

  } catch (e) {
      this.logger.warn(`Failed to fetch LinkedIn Page Stats for ${shareUrn}: ${e.message}`);
      return null;
  }
}

async fetchTwitterMetrics(
    post: any,
  ): Promise<PostMetrics | null> {
    // 1. Validate credentials
    if (!post.socialAccount?.accessToken || !post.socialAccount?.accessSecret) {
      return null;
    }
    const [decryptedAccessToken, decryptedAccessSecret] = await Promise.all([
      this.encryptionService.decrypt(post.socialAccount?.accessToken),
      this.encryptionService.decrypt(post.socialAccount?.accessSecret),
    ]);

    try {
      // 2. Initialize the Client with User Context (OAuth 1.0a)
      // This allows you to access private metrics (Impressions/Clicks) if your App permissions allow it.
      const client = new TwitterApi({
        appKey: this.appKey,
        appSecret: this.appSecret,
        accessToken: decryptedAccessToken,
        accessSecret: decryptedAccessSecret,
      } as any);

      // 3. Fetch the Tweet
      // .v2.tweets() accepts an array of IDs or a single ID string
      const result = await client.v2.tweets(post.platformPostId, {
        'tweet.fields': ['public_metrics', 'non_public_metrics'],
      });

      const tweetData = result.data[0] as any; // .tweets() always returns an array wrapper in .data
      if (!tweetData) return null;

      const publicMetrics = (tweetData.public_metrics as any) || {};
      const nonPublicMetrics = (tweetData.non_public_metrics as any) || {};

      return {
        likes: publicMetrics.like_count || 0,
        comments: publicMetrics.reply_count || 0,
        shares:
          (publicMetrics.retweet_count || 0) + (publicMetrics.quote_count || 0),

        // Impressions (non_public requires OAuth 1.0a User Context)
        impressions:
          nonPublicMetrics.impression_count ||
          publicMetrics.impression_count ||
          0,

        // Clicks (Sum of URL clicks + Profile clicks)
        clicks:
          (nonPublicMetrics.url_link_clicks || 0) +
          (nonPublicMetrics.user_profile_clicks || 0),

        reach: 0, // Not provided by API v2
      };
    } catch (e) {
      this.logger.error(
        `[X] Failed post sync ${post.platformPostId}: ${e.message}`,
      );
      return null;
    }
  }

  async upsertSnapshot(postId: string, metrics: PostMetrics) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const existingSnapshot = await this.prisma.postAnalyticsSnapshot.findFirst({
      where: {
        postId: postId,
        recordedAt: { gte: todayStart, lte: todayEnd },
      },
    });

    const dataPayload = {
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      impressions: metrics.impressions,
      reach: metrics.reach,
      clicks: metrics.clicks,
      recordedAt: new Date(),
    };

    if (existingSnapshot) {
      await this.prisma.postAnalyticsSnapshot.update({
        where: { id: existingSnapshot.id },
        data: dataPayload,
      });
    } else {
      await this.prisma.postAnalyticsSnapshot.create({
        data: {
          postId,
          ...dataPayload,
        },
      });
    }
  }
}
