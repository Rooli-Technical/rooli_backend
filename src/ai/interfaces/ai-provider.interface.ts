export interface AiResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost?: number;
  };
}

export interface AiImageResponse {
  urls: string[];
  cost?: number;
}

export interface IAiProvider {
  generateText(prompt: string, systemPrompt?: string, model?: string): Promise<AiResponse>;
  generateImage(prompt: string, options?: { width?: number; height?: number }): Promise<AiImageResponse>;
}