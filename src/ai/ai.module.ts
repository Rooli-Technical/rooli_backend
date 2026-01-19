import { Module } from '@nestjs/common';
import { AiService } from './service/ai.service';
import { AiController } from './ai.controller';
import { QuotaService } from './service/quota.service';
import { AiFactory } from './service/ai.factory';
import { GeminiProvider } from './providers/gemini.provider';
import { HuggingFaceProvider } from './providers/hugging-face.provider';

@Module({
  controllers: [AiController],
  providers: [AiService, QuotaService, AiFactory, GeminiProvider, HuggingFaceProvider],
})
export class AiModule {}
