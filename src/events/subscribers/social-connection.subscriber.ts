import { AnalyticsService } from '@/analytics/services/analytics.service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventsService } from '../domain-events.service';

@Injectable()
export class ProfileConnectionSubscriber {
  private readonly logger = new Logger(ProfileConnectionSubscriber.name);

  constructor(
    private readonly analyticsService: AnalyticsService,
  ) {}

  @OnEvent('system.social_profile.connected', { async: true })
  async handleNewProfileConnection(evt: {
    workspaceId: string;
    profileId: string;
    platform: string;
  }) {
    this.logger.log(
      `New profile connected (${evt.platform}). Triggering initial analytics sync...`,
    );

    try {
      await this.analyticsService.testFetch({ profileId: evt.profileId });


      this.logger.log(
        `Initial analytics sync complete for profile: ${evt.profileId}`,
      );
    } catch (error: any) {
      // If the fetch fails, the UI doesn't crash. The user just sees an empty dashboard
      // until the next scheduled cron job tries again.
      this.logger.error(
        `Failed to fetch initial analytics for profile ${evt.profileId}: ${error.message}`,
      );
    }
  }
}
