import { Platform } from "@generated/enums";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { MetaService } from "./meta/meta.service";
import { LinkedInService } from "./linkedin/linkedIn.service";

@Processor('auth')
export class AuthProcessor extends WorkerHost {
  constructor(
    private readonly metaService: MetaService,
    private readonly linkedinService: LinkedInService,
  ) {
    super();
  }

  async process(job: Job<{ accountId: string; platform: Platform }>) {
    const { accountId, platform } = job.data;

    try {
      switch (platform) {
        case Platform.META:
          await this.metaService.refreshAccessToken(accountId);
          break;
        
        case Platform.LINKEDIN:
          await this.linkedinService.requestTokenRefresh(accountId);
          break;
                   
        default:
          throw new Error(`Unsupported platform for refresh: ${platform}`);
      }
    } catch (error) {
      // If refresh fails, you might want to mark the account as requiring re-login
      console.error(`Failed to refresh ${platform} token:`, error);
      throw error; // Let BullMQ handle retries
    }
  }
}