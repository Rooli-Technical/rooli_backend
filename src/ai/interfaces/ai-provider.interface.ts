import { AiProvider } from '@generated/enums';
import { ImageGenMetadata } from '../types/ai.types';

export interface IAiProvider {
  generateText(options: TextGenOptions): Promise<TextGenResult>;

  // 🎨 Optional method: Not every provider has an "artist" inside
  generateImage?(prompt: string, model?: string): Promise<{ buffer: Buffer; metadata: ImageGenMetadata }>;
}

export interface TextGenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface TextGenResult {
  text: string;
  model: string;
  provider: AiProvider;
  usage: TextGenUsage;
}

export interface TextGenOptions {
  system?: string;
  user: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}
