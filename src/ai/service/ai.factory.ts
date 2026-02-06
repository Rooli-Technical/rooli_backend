import { AiProvider } from "@generated/enums";
import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { IAiProvider } from "../interfaces/ai-provider.interface";
import { GeminiProvider } from "../providers/gemini.provider";


@Injectable()
export class AiProviderFactory {
  constructor(
    private readonly gemini: GeminiProvider,
    // private readonly openai: OpenAiProvider, 
  ) {}

  /**
   * Returns the appropriate AI provider instance.
   */
  getTextProvider(provider: AiProvider): IAiProvider {
    switch (provider) {
      case AiProvider.GEMINI:
        return this.gemini;

      case AiProvider.OPENAI:
        // return this.openai;
        throw new InternalServerErrorException('OpenAI provider is not yet enabled.');

      default:
        // Default to Gemini as it's our primary free-tier provider
        return this.gemini;
    }
  }
}