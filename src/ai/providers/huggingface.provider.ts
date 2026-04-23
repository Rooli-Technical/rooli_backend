import {
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
  Logger,
  UnauthorizedException,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  IAiProvider,
  TextGenOptions,
  TextGenResult,
} from '../interfaces/ai-provider.interface';
import { AiProvider } from '@generated/enums';

@Injectable()
export class HuggingFaceProvider implements IAiProvider {
  private readonly logger = new Logger(HuggingFaceProvider.name);
  private readonly client: OpenAI;
  private readonly apiKey: string;

  // Default fallback — a fast non-reasoning model currently deployed on HF Router
  private readonly defaultModel = 'meta-llama/Llama-3.3-70B-Instruct:novita';
  
  // Known reasoning models — these need larger token budgets
  private readonly reasoningModels = new Set([
    'zai-org/GLM-4.6:novita',
    'deepseek-ai/DeepSeek-R1',
    'deepseek-ai/DeepSeek-V3',
  ]);

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('HF_API_KEY');

    if (!this.apiKey) {
      throw new Error('HF_API_KEY not found in environment variables.');
    }

    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: 'https://router.huggingface.co/v1',
    });
  }

  async generateText(options: TextGenOptions): Promise<TextGenResult> {
    try {
      // 👇 RESPECT THE MODEL PARAMETER FROM THE CALLER
      const model = options.model || this.defaultModel;
      const isReasoning = this.reasoningModels.has(model);

      // 👇 REASONING MODELS NEED MUCH MORE HEADROOM
      // Non-reasoning: 500 tokens is plenty for a tweet
      // Reasoning: 500 tokens is eaten entirely by thinking
      const defaultMaxTokens = isReasoning ? 4000 : 1000;
      const maxTokens = options.maxTokens ?? defaultMaxTokens;

      const completion = await this.client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: options.system || 'You are a helpful AI assistant.',
          },
          { role: 'user', content: options.user },
        ],
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.7,
      });

      const content = completion.choices[0]?.message?.content || '';
      const finishReason = completion.choices[0]?.finish_reason;

      // 👇 DETECT REASONING EXHAUSTION
      if (!content && finishReason === 'length') {
        const completionTokens = completion.usage?.completion_tokens ?? 0;
        this.logger.error(
          `Model ${model} hit token cap (${completionTokens}/${maxTokens}) with empty output. Likely reasoning exhaustion — increase maxTokens.`,
        );
        throw new ServiceUnavailableException(
          'AI model ran out of tokens before producing a response. Please retry.',
        );
      }

      if (!content) {
        this.logger.warn(
          `Model ${model} returned empty content. Finish reason: ${finishReason}`,
        );
      }

      this.logger.log(
        `Generated text using ${model} (${completion.usage?.completion_tokens ?? 0} tokens)`,
      );

      return {
        text: content,
        model: completion.model,
        provider: AiProvider.HUGGINGFACE,
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
          totalTokens: completion.usage?.total_tokens ?? 0,
        },
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      this.handleError(error);
    }
  }

  // generateImage stays the same
  async generateImage(
    prompt: string,
    model: string = 'stabilityai/stable-diffusion-xl-base-1.0',
  ): Promise<Buffer> {
    try {
      const response = await fetch(
        'https://router.huggingface.co/nscale/v1/images/generations',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            prompt,
            response_format: 'b64_json',
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new ServiceUnavailableException(
          `HF image generation failed: ${text}`,
        );
      }

      const result = await response.json();
      const imageBase64 = result.data?.[0]?.b64_json;

      if (!imageBase64) throw new Error('No image data returned from API');

      return Buffer.from(imageBase64, 'base64');
    } catch (error: any) {
      this.logger.error(`❌ Image generation failed: ${error.message}`);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('Image generation failed.');
    }
  }

  private handleError(error: any): never {
    this.logger.error('Hugging Face Router API call failed:', error);

    if (error.code === 'invalid_api_key' || error.status === 401) {
      throw new UnauthorizedException('Invalid Hugging Face API token');
    }
    if (error.status === 404) {
      throw new NotFoundException(
        `Model not found or not accessible via Router`,
      );
    }
    if (error.status === 429) {
      throw new ServiceUnavailableException(
        'Rate limit exceeded for Hugging Face Router API',
      );
    }

    throw new InternalServerErrorException('AI Generation failed');
  }
}
