import { Controller } from '@nestjs/common';
import { SupportTicketService } from './support-ticket.service';

@Controller('support-ticket')
export class SupportTicketController {
  constructor(private readonly supportTicketService: SupportTicketService) {}
}
