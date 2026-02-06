import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { IAiProvider, TextGenOptions, TextGenResult } from '../interfaces/ai-provider.interface';
import { AiProvider } from '@generated/enums';

@Injectable()
export class OpenAiProvider implements IAiProvider {
  private client: OpenAI;
  private logger = new Logger(OpenAiProvider.name);

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async generateText(options: TextGenOptions): Promise<TextGenResult> {
    return {
      text: '',
      model: '',
      provider: AiProvider.OPENAI,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    };
  }
}