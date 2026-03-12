import { Controller } from '@nestjs/common';
import { AdminTicketsService } from './support-ticket.service';


@Controller('support-ticket')
export class SupportTicketController {
  constructor(private readonly supportTicketService: AdminTicketsService) {}
}
