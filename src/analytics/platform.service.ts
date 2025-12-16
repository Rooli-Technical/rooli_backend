import { SocialPlatform } from "@/social-scheduler/interfaces/social-scheduler.interface";
import { Injectable } from "@nestjs/common";
import { PageMetrics } from "./interfaces/page-metrics.interface";
import { PostMetrics } from "./interfaces/post-metrics.interface";
import { AnalyticsStrategy, AuthContext, PageAnalyticsStrategy } from "./interfaces/analytics.interface";
import { FacebookPageStrategy } from "./strategies/facebook/facebook-page.strategy";
import { FacebookPostStrategy } from "./strategies/facebook/facebook-post.strategy";
import { InstagramPageStrategy } from "./strategies/instagram/instagram-page.strategy";
import { InstagramPostStrategy } from "./strategies/instagram/instagram-post.strategy";
import { TwitterPageStrategy } from "./strategies/twitter/twitter-page.strategy";
import { TwitterPostStrategy } from "./strategies/twitter/twitter-post.strategy";
import { LinkedinPageStrategy } from "./strategies/linkedin/linkedIn-page.strategy";
import { LinkedinPostStrategy } from "./strategies/linkedin/linkedIn-post.strategy";
import { Platform } from "@generated/enums";

@Injectable()
export class PlatformService {
  constructor(
    private readonly fbPage: FacebookPageStrategy,
    private readonly fbPost: FacebookPostStrategy,
    private readonly igPage: InstagramPageStrategy,
    private readonly igPost: InstagramPostStrategy,
    private readonly xPage: TwitterPageStrategy,
    private readonly xPost: TwitterPostStrategy,
    private readonly liPage: LinkedinPageStrategy,
    private readonly liPost: LinkedinPostStrategy,
  ) {}

  fetchPostMetrics(
    platform: Platform,
    account: AuthContext,
    postIds: string[],
  ): Promise<Record<string, PostMetrics>> {
    return this.getPostStrategy(platform).getMetrics(account, postIds);
  }

  fetchPageMetrics(
    platform: Platform,
    account: AuthContext,
  ): Promise<PageMetrics> {
    return this.getPageStrategy(platform).getPageStats(account);
  }

  private getPostStrategy(platform: Platform): AnalyticsStrategy {
    switch (platform) {
      case 'FACEBOOK': return this.fbPost;
      case 'INSTAGRAM': return this.igPost;
      case 'X': return this.xPost;
      case 'LINKEDIN': return this.liPost;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  private getPageStrategy(platform: Platform): PageAnalyticsStrategy {
    switch (platform) {
      case 'FACEBOOK': return this.fbPage;
      case 'INSTAGRAM': return this.igPage;
      case 'X': return this.xPage;
      case 'LINKEDIN': return this.liPage;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }
}
