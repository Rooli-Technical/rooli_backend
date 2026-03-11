import { PrismaModule } from './prisma/prisma.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailModule } from './mail/mail.module';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BillingModule } from './billing/billing.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { OrganizationsModule } from './organizations/organizations.module';
import { WebhookModule } from './webhook/webhook.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { RedisModule } from './redis/redis.module';
import { BullModule } from '@nestjs/bullmq';
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
import { AiModule } from './ai/ai.module';
import { RooliBullBoardModule } from './common/bull-boad/bull-board.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { BrandkitModule } from './brandkit/brandkit.module';
import { CalendarModule } from './calendar/calendar.module';
import { RbacModule } from './rbac/rbac.module';
import { UserModule } from './user/user.module';
import { AuditModule } from './audit/audit.module';
import { AuditInterceptor } from './audit/interceptors/audit.intercetor';
import { InboxModule } from './messages/inbox.module';
import { NotificationsModule } from './notifications/notifications.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PollingModule } from './polling/polling.module';
import { SupportTicketModule } from './support-ticket/support-ticket.module';
import Redis from 'ioredis';

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
      // 1. We inject the existing client from your RedisModule
      inject: ['REDIS_CLIENT'], 
      useFactory: (redisClient: Redis) => {
        return {
          // 2. Pass the actual instance, NOT a config object.
          // This forces BullMQ to share the existing socket.
          connection: redisClient, 
          defaultJobOptions: {
            removeOnComplete: true,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
          },
        };
      },
    }),

    MailModule,

    RedisModule,

    WebhookModule,

    OrganizationsModule,

    BillingModule,

    // ApprovalsModule,


    RooliBullBoardModule,

    // AccessControlModule,

    WorkspaceModule,

    SocialConnectionModule,

    SocialProfileModule,

    MetaWebhooksModule,

    PostModule,

    PostMediaModule,


    QueueModule,

    SocialModule,

    CampaignsModule,

    AiModule,

    AnalyticsModule,

    BrandkitModule,

    CalendarModule,

    RbacModule,
    
    UserModule,
    
    AuditModule,
    
    InboxModule,
    
    NotificationsModule,

    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 10,
    }),

    PollingModule,

    SupportTicketModule,
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
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
})
export class AppModule {}
