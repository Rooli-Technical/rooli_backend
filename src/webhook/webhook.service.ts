import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Platform } from '@generated/enums';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor() {}
}
