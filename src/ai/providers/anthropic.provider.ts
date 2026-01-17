import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { IAiProvider, AiResponse, AiImageResponse } from '../interfaces/ai-provider.interface';

@Injectable()
export class AnthropicProvider implements IAiProvider {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async generateText(prompt: string, systemPrompt?: string, model = 'claude-3-5-sonnet-20240620'): Promise<AiResponse> {
    const response = await this.client.messages.create({
      model: model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    // Anthropic response content is an array of blocks
    const textBlock = response.content.find(c => c.type === 'text');
    const content = textBlock?.type === 'text' ? textBlock.text : '';

    return {
      content: content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async generateImage(): Promise<AiImageResponse> {
    throw new Error('Anthropic does not generate images.');
  }
}