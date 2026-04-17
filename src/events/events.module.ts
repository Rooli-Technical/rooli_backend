import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { DomainEventsService } from './domain-events.service';
import { EventsGateway } from './events.gateway';
import { InboxEventsSubscriber } from './subscribers/inbox-events.subscriber';
import { WsAuthMiddleware } from './ws-auth.middleware';
import { RealtimeEmitterService } from './realtime-emitter.service';
import { RedisModule } from '@/redis/redis.module';
import { NotificationsEventsSubscriber } from './subscribers/notifications-events.subscriber';
import { ProfileConnectionSubscriber } from './subscribers/social-connection.subscriber';
import { AnalyticsModule } from '@/analytics/analytics.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TicketEventsSubscriber } from './subscribers/tickets-events.subscriber';
import { MailModule } from '@/mail/mail.module';

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
      inject: [ConfigService],
    }),
    RedisModule,
    AnalyticsModule,
    MailModule
  ],
  providers: [
    PrismaService,
    DomainEventsService,
    EventsGateway,
    InboxEventsSubscriber,
    RealtimeEmitterService,
    NotificationsEventsSubscriber,
    WsAuthMiddleware,
    ProfileConnectionSubscriber,
    TicketEventsSubscriber,
  ],
  exports: [DomainEventsService, RealtimeEmitterService],
})
export class EventsModule {}
