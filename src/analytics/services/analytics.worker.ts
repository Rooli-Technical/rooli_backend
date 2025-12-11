import { PrismaService } from "@/prisma/prisma.service";
import { Injectable, Logger } from "@nestjs/common";
import { AnalyticsPostService } from "./analytics-post.service";
import { AnalyticsPageService } from "./analytics-page.service";

@Injectable()
export class AnalyticsWorkerService {
  private readonly logger = new Logger(AnalyticsWorkerService.name);

  constructor(
    private prisma: PrismaService,
    private postService: AnalyticsPostService,
    private pageService: AnalyticsPageService,
  ) {}

  async syncPost(post: any) {
    try {
        let metrics = null;
        
        switch (post.platform) {
            case 'META': // Handles FB & IG
            case 'FACEBOOK':
            case 'INSTAGRAM':
                metrics = await this.postService.fetchMetaMetrics(post);
                break;
            case 'LINKEDIN':
                metrics = await this.postService.fetchLinkedInMetrics(post);
                break;
            case 'X':
                metrics = await this.postService.fetchTwitterMetrics(post);
                break;
        }

        if (metrics) {
            await this.postService.upsertSnapshot(post.id, metrics);
        }
    } catch (error) {
        this.handleApiError(post, error);
    }
  }

  async syncAccount(account: any) {
    this.logger.log(`Syncing daily stats for ${account.name || account.username}`);

    const yesterday = this.pageService.getYesterdayRange();
    const platform = account.platform || account.socialAccount?.platform;

    this.logger.log(`Syncing daily stats for ${account.name || account.username} [${platform}]`);

    try {
      // 1. FACEBOOK & INSTAGRAM (Meta)
      // Usually stored in PageAccount
      if (platform === 'META' || platform === 'FACEBOOK') {
        await this.pageService.syncFacebookPage(account, yesterday);
        
        // If this PageAccount also has an IG Business ID linked, sync IG too
        if (account.instagramBusinessId) {
          await this.pageService.syncInstagramAccount(account, yesterday);
        }
      } 
      
      // 2. LINKEDIN ORGANIZATIONS
      // Stored in PageAccount
      else if (platform === 'LINKEDIN') {
        await this.pageService.syncLinkedInPage(account, yesterday);
      } 
      
      // 3. X (TWITTER) USERS
      // Stored in SocialAccount
      else if (platform === 'X') {
        await this.pageService.syncTwitterAccount(account, yesterday);
      }

    } catch (error) {
      this.handleApiError(account, error);
    }
  }

  // ERROR HANDLING STRATEGY
  private async handleApiError(post: any, error: any) {
      // 1. Check for Rate Limits
      if (error.response?.status === 429) {
          this.logger.warn(`Rate Limit Hit for ${post.platform}. Backing off.`);
          // Logic: Push nextAnalyticsCheck forward by 2 hours immediately
          await this.prisma.post.update({
              where: { id: post.id },
              data: { nextAnalyticsCheck: new Date(Date.now() + 2 * 60 * 60 * 1000) }
          });
          return;
      }

      // 2. Check for Expired Tokens (Very Common)
      if (error.response?.data?.error?.code === 190) { 
           this.logger.error(`Token Expired for Page ${post.pageAccount.id}`);          
      }
  }
}