import { PrismaModule } from './prisma/prisma.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { MailModule } from './mail/mail.module';
import { RedisModule } from './redis/redis.module';
import { PostsModule } from './posts/posts.module';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsModule } from './role-permissions/permissions.module';
import { UserModule } from './user/user.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { BillingModule } from './billing/billing.module';
import { AiModule } from './ai/ai.module';
import { MessagingModule } from './messaging/messaging.module';
import { TemplatesModule } from './templates/templates.module';
import { WebhookModule } from './webhook/webhook.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { NotificationModule } from './notification/notification.module';
import { SocialIntegrationModule } from './social-integration/social-integration.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { BrandKitModule } from './brand-kit/brand-kit.module';
import { SocialAccountModule } from './social-account/social-account.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { MetaModule } from './social-integration/meta/meta.module';
import { SocialSchedulerModule } from './social-scheduler/social-scheduler.module';
import { BullBoardModule } from './common/bull-boad/bull-board.module';
import { BullModule } from '@nestjs/bullmq';
import { AccessControlModule } from './access-control/access-control.module';


@Module({
  imports: [
    // 1. First configure BullMQ root module
    // BullModule.forRootAsync({
    //   inject: ['REDIS_CLIENT'],
    //   useFactory: (redisClient) => ({
    //     connection: redisClient,
    //   }),
    // }),
    BullModule.forRoot({
          connection: {
            host: 'localhost', // Your Redis host
            port: 6379, // Your Redis port
          },
        }),

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

    // Task scheduling
    ScheduleModule.forRoot(),

    MailModule,


    RedisModule,

    PostsModule,

    AiModule,

    MessagingModule,

    TemplatesModule,


    WebhookModule,

    AnalyticsModule,

    NotificationModule,

    SocialIntegrationModule,

    RateLimitModule,

    BrandKitModule,

    MetaModule,


    //AuditModule,

    //PollingModule,

    SocialAccountModule,

    OrganizationsModule,

    BillingModule,

    ApprovalsModule,

    UserModule,

    PermissionsModule,


    SocialSchedulerModule,

    BullBoardModule,

    AccessControlModule, 
  ],
  controllers: [AppController],
  providers: [AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
