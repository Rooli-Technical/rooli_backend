import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { IAiProvider, AiResponse, AiImageResponse } from '../interfaces/ai-provider.interface';

@Injectable()
export class GeminiProvider implements IAiProvider {
  private client: GoogleGenerativeAI;
  private logger = new Logger(GeminiProvider.name);

  constructor() {
    this.client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  async generateText(prompt: string, systemPrompt?: string, model = 'gemini-1.5-flash'): Promise<AiResponse> {
    try {
      // Gemini handles system prompts slightly differently (as context or config)
      // For simplicity in the free tier SDK, we often prepend it.
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\nUser Request: ${prompt}` : prompt;
      
      const genModel = this.client.getGenerativeModel({ model: model });
      const result = await genModel.generateContent(fullPrompt);
      const response = await result.response;
      
      return {
        content: response.text(),
        usage: {
          // Gemini doesn't always return exact token counts in the simplified response
          // You often have to estimate or count strictly if needed for billing
          inputTokens: 0, 
          outputTokens: 0, 
        },
      };
    } catch (error) {
      this.logger.error(`Gemini Error: ${error.message}`);
      throw error;
    }
  }

  async generateImage(prompt: string): Promise<AiImageResponse> {
    throw new Error('Gemini Image Generation not implemented in this version (Use Imagen on Vertex AI for production)');
  }
}