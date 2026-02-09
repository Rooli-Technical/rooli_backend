import { Injectable, InternalServerErrorException, ServiceUnavailableException, Logger, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { IAiProvider, TextGenOptions, TextGenResult } from '../interfaces/ai-provider.interface';
import { AiProvider } from '@generated/enums';



@Injectable()
export class HuggingFaceProvider implements IAiProvider {
  private readonly logger = new Logger(HuggingFaceProvider.name);
  private readonly client: OpenAI;
  private readonly apiKey: string;
  
  private readonly textModel = 'zai-org/GLM-4.6:novita'; 

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('HF_API_KEY');

    if (!this.apiKey) {
      throw new Error('HF_ACCESS_TOKEN not found in environment variables.');
    }

    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: 'https://router.huggingface.co/v1', 
    });
  }

  /**
   * ✍️ GENERATE TEXT (Via OpenAI SDK)
   */
  async generateText(options: TextGenOptions): Promise<TextGenResult> {
    try {
      const model =  this.textModel;
      
      const completion = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: 'system',
            content: options.system || 'You are a helpful AI assistant.',
          },
          {
            role: 'user',
            content: options.user,
          },
        ],
        max_tokens: options.maxTokens ?? 500,
        temperature: options.temperature ?? 0.7,
      });

      this.logger.log(`Generated text using model: ${model}`);

      // Map the OpenAI response to your App's standard result format
      return {
        text: completion.choices[0]?.message?.content || '',
        model: completion.model,
        provider: AiProvider.HUGGINGFACE,
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
          totalTokens: completion.usage?.total_tokens ?? 0,
        },
      };

    } catch (error: any) {
      this.handleError(error);
    }
  }

  /**
   * 🎨 GENERATE IMAGE (Via Custom Fetch)
   * Adapted to return a Buffer so PostMediaService can upload it.
   */
  async generateImage(prompt: string, model: string = 'stabilityai/stable-diffusion-xl-base-1.0'): Promise<Buffer> {
    try {
      // ✅ Using your specific Router Endpoint
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
            response_format: 'b64_json', // We request Base64 to convert to Buffer
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new ServiceUnavailableException(`HF image generation failed: ${text}`);
      }

      const result = await response.json();
      const imageBase64 = result.data?.[0]?.b64_json;

      if (!imageBase64) throw new Error('No image data returned from API');

      // ✅ CONVERSION: Base64 String -> Buffer
      // This allows CloudinaryService to upload it effortlessly
      return Buffer.from(imageBase64, 'base64');

    } catch (error: any) {
      this.logger.error(`❌ Image generation failed: ${error.message}`);
      throw new InternalServerErrorException('Image generation failed.');
    }
  }

  // Centralized Error Handling
  private handleError(error: any): never {
    this.logger.error('Hugging Face Router API call failed:', error);

    if (error.code === 'invalid_api_key' || error.status === 401) {
      throw new UnauthorizedException('Invalid Hugging Face API token');
    } 
    if (error.status === 404) {
      throw new NotFoundException(`Model not found or not accessible via Router`);
    } 
    if (error.status === 429) {
      throw new ServiceUnavailableException('Rate limit exceeded for Hugging Face Router API');
    }

    throw new InternalServerErrorException('AI Generation failed');
  }
}