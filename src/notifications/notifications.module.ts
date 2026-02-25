import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EventsModule } from '@/events/events.module';
import { NotificationsSubscriber } from './notifications.subscriber';

@Module({
  imports: [EventsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsSubscriber],
})
export class NotificationsModule {}
