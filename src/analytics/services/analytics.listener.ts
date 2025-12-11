import { QueueEventsHost, QueueEventsListener, OnQueueEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

@QueueEventsListener('analytics-queue')
export class AnalyticsQueueEvents extends QueueEventsHost {
  private readonly logger = new Logger(AnalyticsQueueEvents.name);

  @OnQueueEvent('completed')
  onCompleted(job: { jobId: string; returnvalue: any }) {
    // Optional: noisy, maybe only log in debug mode
    this.logger.debug(`Job ${job.jobId} completed!`);
  }

  @OnQueueEvent('failed')
  onFailed(job: { jobId: string; failedReason: string }) {
    this.logger.error(`🚨 Job ${job.jobId} FAILED. Reason: ${job.failedReason}`);
    
    // TODO: Add alert logic here
    // e.g., sendSlackNotification(`Analytics sync failed for Post ${job.jobId}`);
  }

  @OnQueueEvent('stalled')
  onStalled(job: { jobId: string }) {
    this.logger.warn(`⚠️ Job ${job.jobId} is stalled (worker might have crashed).`);
  }
}