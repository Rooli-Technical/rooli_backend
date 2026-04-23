export type BrandKitLike = {
  name?: string;
  handle?: string | null;
  brandVoice?: string | null;
  tone?: string | null;
  colors?: any;
  guidelines?: any;
};


export interface ImageGenMetadata {
  model: string;
  provider: 'huggingface' | 'openai' | 'replicate';
  durationMs: number;
  imageCount: number;
  sizeBytes: number;
  hfCreated: number | null;
  revisedPrompt: string | null;
  rawResponse: Record<string, any>;
}