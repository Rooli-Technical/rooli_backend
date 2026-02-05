import { PrismaModule } from './prisma/prisma.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailModule } from './mail/mail.module';
import { APP_GUARD } from '@nestjs/core';
import { BillingModule } from './billing/billing.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { OrganizationsModule } from './organizations/organizations.module';
import { WebhookModule } from './webhook/webhook.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { RedisModule } from './redis/redis.module';
// import { PostsModule } from './posts/posts.module';
// import { APP_GUARD } from '@nestjs/core';
// import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
// import { UserModule } from './user/user.module';
// import { ApprovalsModule } from './approvals/approvals.module';
// import { BillingModule } from './billing/billing.module';
// import { AiModule } from './ai/ai.module';
// import { MessagingModule } from './messaging/messaging.module';
// import { TemplatesModule } from './templates/templates.module';
// import { WebhookModule } from './webhook/webhook.module';
// import { NotificationModule } from './notification/notification.module';
// import { SocialIntegrationModule } from './social-integration/social-integration.module';
// import { RateLimitModule } from './rate-limit/rate-limit.module';
// import { BrandKitModule } from './brand-kit/brand-kit.module';
// import { SocialAccountModule } from './social-account/social-account.module';
// import { OrganizationsModule } from './organizations/organizations.module';
// import { MetaModule } from './social-integration/meta/meta.module';
// import { SocialSchedulerModule } from './social-scheduler/social-scheduler.module';
// import { BullBoardModule } from './common/bull-boad/bull-board.module';
import { BullModule } from '@nestjs/bullmq';
// import { AccessControlModule } from './access-control/access-control.module';
// import { AnalyticsModule } from './analytics/analytics.module';
// import { SubscriptionGuard } from './common/guards/subscription.guard';
// import { WorkspaceModule } from './workspace/workspace.module';
import { SocialConnectionModule } from './social-connection/social-connection.module';
import { SocialProfileModule } from './social-profile/social-profile.module';
import { SubscriptionGuard } from './common/guards/subscription.guard';
import { MetaWebhooksModule } from './meta-webhooks/meta-webhooks.module';
import { PostModule } from './post/post.module';
import { PostMediaModule } from './post-media/post-media.module';
import { WorkerModule } from './worker/worker.module';
import { QueueModule } from './queue/queue.module';
import { ScheduleModule } from '@nestjs/schedule';
import { SocialModule } from './social/social.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { LabelsModule } from './labels/labels.module';
import { AiModule } from './ai/ai.module';
import { RooliBullBoardModule } from './common/bull-boad/bull-board.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { BrandkitModule } from './brandkit/brandkit.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60 * 1000, // 1 minute
        limit: 10, // 100 requests per minute
      },
    ]),

    BullModule.forRootAsync({
      useFactory: () => {
        if (process.env.REDIS_URL) {
          const url = new URL(process.env.REDIS_URL);
          const isTls = process.env.REDIS_URL.startsWith('rediss://');

          return {
            connection: {
              host: url.hostname,
              port: Number(url.port),
              username: url.username || undefined,
              password: url.password || undefined,
              ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
            },
          };
        }

        return {
          connection: {
            host: process.env.REDIS_HOST || 'localhost',
            port: Number(process.env.REDIS_PORT || 6379),
            password: process.env.REDIS_PASSWORD || undefined,
          },
        };
      },
    }),

    MailModule,

    RedisModule,

    // PostsModule,

    // AiModule,

    // MessagingModule,

    // TemplatesModule,

    WebhookModule,

    //AnalyticsModule,

    //NotificationModule,

    //SocialIntegrationModule,

    //RateLimitModule,

    //BrandKitModule,

    //MetaModule,

    //AuditModule,

    //PollingModule,

    //SocialAccountModule,

    OrganizationsModule,

    BillingModule,

    // ApprovalsModule,

    // UserModule,

    // AccessControlModule,

    // SocialSchedulerModule,

    RooliBullBoardModule,

    // AccessControlModule,

    WorkspaceModule,

    SocialConnectionModule,

    SocialProfileModule,

    MetaWebhooksModule,

    PostModule,

    PostMediaModule,

    WorkerModule,

    QueueModule,

    SocialModule,

    CampaignsModule,

    LabelsModule,

    AiModule,

    AnalyticsModule,

    BrandkitModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SubscriptionGuard, // Applies to EVERYTHING by default
    },
  ],
})
export class AppModule {}
