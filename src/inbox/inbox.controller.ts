import { Controller } from '@nestjs/common';
import { InboxService } from './services/inbox.service';

@Controller('inbox')
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}
}
