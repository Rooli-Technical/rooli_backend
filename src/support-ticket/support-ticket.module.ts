import { Module } from '@nestjs/common';
import { SupportTicketService } from './support-ticket.service';
import { SupportTicketController } from './support-ticket.controller';

@Module({
  controllers: [SupportTicketController],
  providers: [SupportTicketService],
})
export class SupportTicketModule {}
