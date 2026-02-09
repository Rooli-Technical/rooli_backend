import { Module } from '@nestjs/common';
import { AiService } from './service/ai.service';
import { AiController } from './ai.controller';
import { AiQuotaService } from './service/quota.service';
import { AiProviderFactory } from './service/ai.factory';
import { GeminiProvider } from './providers/gemini.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { PromptBuilder } from './service/prompt.service';
import { ScraperService } from './service/scraper.service';
import { PostMediaModule } from '@/post-media/post-media.module';
import { HuggingFaceProvider } from './providers/huggingface.provider';

@Module({
  imports:[PostMediaModule],
  controllers: [AiController],
  providers: [AiService, AiQuotaService, AiProviderFactory , GeminiProvider, OpenAiProvider, PromptBuilder, ScraperService, HuggingFaceProvider],
})
export class AiModule {}
