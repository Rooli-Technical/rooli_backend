import { Module } from '@nestjs/common';
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

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    JwtModule.register({
      secret: process.env.JWT_SECRET!,
      signOptions: { expiresIn: '7d' },
    }),
    RedisModule
  ],
  providers: [
    PrismaService,
    DomainEventsService,
    EventsGateway,
    InboxEventsSubscriber,
    RealtimeEmitterService,
    NotificationsEventsSubscriber,
    WsAuthMiddleware,
  ],
  exports: [DomainEventsService, RealtimeEmitterService,],
})
export class EventsModule {}
