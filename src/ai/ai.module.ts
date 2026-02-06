import { Module } from '@nestjs/common';
import { AiService } from './service/ai.service';
import { AiController } from './ai.controller';
import { AiQuotaService } from './service/quota.service';
import { AiProviderFactory } from './service/ai.factory';
import { GeminiProvider } from './providers/gemini.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { PromptBuilder } from './service/prompt.service';
import { ScraperService } from './service/scraper.service';

@Module({
  controllers: [AiController],
  providers: [AiService, AiQuotaService, AiProviderFactory , GeminiProvider, OpenAiProvider, PromptBuilder, ScraperService],
})
export class AiModule {}
