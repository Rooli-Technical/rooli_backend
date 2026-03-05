import { Controller } from '@nestjs/common';
import { PollingService } from './polling.service';

@Controller('polling')
export class PollingController {
  constructor(private readonly pollingService: PollingService) {}
}
