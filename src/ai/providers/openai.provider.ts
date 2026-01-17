import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { IAiProvider, AiResponse, AiImageResponse } from '../interfaces/ai-provider.interface';

@Injectable()
export class OpenAiProvider implements IAiProvider {
  private client: OpenAI;
  private logger = new Logger(OpenAiProvider.name);

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async generateText(prompt: string, systemPrompt = 'You are a helpful assistant.', model = 'gpt-4o'): Promise<AiResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: model, 
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      });

      return {
        content: response.choices[0].message.content || '',
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
      };
    } catch (error) {
      this.logger.error(`OpenAI Error: ${error.message}`);
      throw error;
    }
  }

  async generateImage(prompt: string): Promise<AiImageResponse> {
    const response = await this.client.images.generate({
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
    });

    return { urls: [response.data[0].url] };
  }
}