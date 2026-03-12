import { Module } from '@nestjs/common';

import { SupportTicketController } from './support-ticket.controller';
import { AdminTicketsService } from './support-ticket.service';

@Module({
  controllers: [SupportTicketController],
  providers: [AdminTicketsService],
})
export class SupportTicketModule {}
