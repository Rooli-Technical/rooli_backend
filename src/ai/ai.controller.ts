import { Controller } from '@nestjs/common';
import { AiService } from './service/ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}
}
