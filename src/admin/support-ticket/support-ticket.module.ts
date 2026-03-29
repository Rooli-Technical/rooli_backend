import { Module } from '@nestjs/common';

import {  TicketsController } from './support-ticket.controller';
import { TicketsService } from './support-ticket.service';
import { EventsModule } from '@/events/events.module';
import { TicketsRepository } from './support-ticket.repository';
import { DomainEventsService } from '@/events/domain-events.service';

@Module({
  imports: [EventsModule],
  controllers: [TicketsController],
  providers: [TicketsService, TicketsRepository, DomainEventsService,],
  exports:[TicketsService]
})
export class TicketsModule {}
