import { Injectable, Logger } from '@nestjs/common';
import Replicate from 'replicate';
import { IAiProvider, AiResponse, AiImageResponse } from '../interfaces/ai-provider.interface';

@Injectable()
export class ReplicateProvider implements IAiProvider {
  private client: Replicate;
  private logger = new Logger(ReplicateProvider.name);

  // Define Model Slugs (These update occasionally, so keeping them as constants is good)
  // Llama 3 70B is smart (Comparable to GPT-4)
  private readonly TEXT_MODEL = "meta/meta-llama-3-70b-instruct"; 
  
  // Stable Diffusion XL (Great quality, cheap)
  private readonly IMAGE_MODEL = "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b";

  constructor() {
    this.client = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  }

  // 📝 TEXT GENERATION (Llama 3)
  async generateText(prompt: string, systemPrompt?: string, model?: `${string}/${string}` | `${string}/${string}:${string}`): Promise<AiResponse> {
    try {
      this.logger.log(`Running Llama 3 on Replicate...`);

      // Replicate's run() returns the output directly
      const output = await this.client.run(
        model || this.TEXT_MODEL,
        {
          input: {
            prompt: prompt,
            system_prompt: systemPrompt || "You are a helpful assistant.",
            max_tokens: 1024,
            temperature: 0.7,
            top_p: 0.9,
          }
        }
      );

      // Llama 3 on Replicate returns an array of strings (tokens)
      // We need to join them to get the full sentence.
      const fullText = Array.isArray(output) ? output.join('') : String(output);

      return {
        content: fullText,
        usage: {
          // Replicate charges by TIME (seconds), not just tokens.
          // We can't easily get exact token counts from the response wrapper,
          // so we estimate or leave as 0 for now.
          inputTokens: 0, 
          outputTokens: fullText.length / 4, // Rough estimate (4 chars = 1 token)
        }
      };

    } catch (error) {
      this.logger.error(`Replicate Text Error: ${error.message}`);
      throw error;
    }
  }

  // 🖼️ IMAGE GENERATION (Stable Diffusion)
  async generateImage(prompt: string): Promise<AiImageResponse> {
    try {
      this.logger.log(`Running SDXL on Replicate...`);

      const output = await this.client.run(
        this.IMAGE_MODEL,
        {
          input: {
            prompt: prompt,
            width: 1024,
            height: 1024,
            refine: "expert_ensemble_refiner"
          }
        }
      );

      // Replicate returns an array of URLs
      const urls = Array.isArray(output) ? output : [String(output)];
      
      return { urls: urls as string[] };

    } catch (error) {
      this.logger.error(`Replicate Image Error: ${error.message}`);
      throw error;
    }
  }
}