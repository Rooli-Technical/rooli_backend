import { Module } from '@nestjs/common';

import { SupportTicketController } from './support-ticket.controller';
import { AdminTicketsService } from './support-ticket.service';
import { EventsModule } from '@/events/events.module';

@Module({
  imports:[
    EventsModule
  ],
  controllers: [SupportTicketController],
  providers: [AdminTicketsService],
})
export class SupportTicketModule {}
