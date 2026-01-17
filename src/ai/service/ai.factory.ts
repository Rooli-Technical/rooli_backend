import { Injectable } from '@nestjs/common';
import { IAiProvider } from '../interfaces/ai-provider.interface';
import { AnthropicProvider } from '../providers/anthropic.provider';
import { GeminiProvider } from '../providers/gemini.provider';
import { OpenAiProvider } from '../providers/openai.provider';
import { ReplicateProvider } from '../providers/replicate.provider';



@Injectable()
export class AiFactory {
  constructor(
    private openai: OpenAiProvider,
    private gemini: GeminiProvider,
    private anthropic: AnthropicProvider,
    private replicate: ReplicateProvider,
  ) {}

  getProvider(providerName: AiProvider): IAiProvider {
    switch (providerName) {
      case 'OPENAI':
        return this.openai;
      case 'GEMINI':
        return this.gemini;
      case 'ANTHROPIC':
        return this.anthropic;
      case 'REPLICATE':
        return this.replicate;
      // Note: Stability is usually requested explicitly for images, 
      // not generic text generation.
      default:
        return this.openai; // Default fallback
    }
  }

  getImageProvider(): IAiProvider {
    // Return OpenAI (DALL-E) or Stability based on config
    return this.stability; 
  }
}