import { AiProvider } from "@generated/enums";
import { Injectable, BadRequestException, ServiceUnavailableException, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IAiProvider, TextGenOptions, TextGenResult } from "../interfaces/ai-provider.interface";

import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

@Injectable()
export class GeminiProvider implements IAiProvider {
  private genAI: GoogleGenerativeAI;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async generateText(options: TextGenOptions): Promise<TextGenResult> {
    try {
      const model: GenerativeModel = this.genAI.getGenerativeModel({
        model: options.model || 'gemini-1.5-flash',
        systemInstruction: options.system,
      });

      const generationConfig = {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 1000,
        responseMimeType:
          options.responseFormat === 'json'
            ? 'application/json'
            : 'text/plain',
      };

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: options.user }] }],
        generationConfig,
      });

      const response = result.response;
      const text = response.text();

      return {
        text,
        model: options.model || 'gemini-1.5-flash',
        provider: AiProvider.GEMINI,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
          totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
          costUsd: undefined, // Gemini pricing may change
        },
      };
    } catch (error: any) {
      console.error('Gemini Provider Error:', error);

      // Safety / content block
      if (
        error?.response?.promptFeedback?.blockReason ||
        error?.message?.toLowerCase().includes('safety')
      ) {
        throw new BadRequestException(
          'Your prompt was blocked by AI safety filters.',
        );
      }

      // Rate limit / service outage
      if (
        error?.status === 429 ||
        error?.status === 503 ||
        error?.message?.includes('timeout')
      ) {
        throw new ServiceUnavailableException(
          'AI service is temporarily unavailable. Please try again.',
        );
      }

      // Anything else = your bug or unexpected provider issue
      throw new InternalServerErrorException(
        'Unexpected error while generating AI content.',
      );
    }
  }
}
