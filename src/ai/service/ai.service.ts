import { 
  Injectable, 
  Logger, 
  BadRequestException, 
  InternalServerErrorException 
} from '@nestjs/common';
import { AiFactory } from './ai.factory';
import { v2 as cloudinary } from 'cloudinary'; // ☁️ Direct Cloudinary Import
import * as cheerio from 'cheerio';            // 🕷️ Scraper
import axios from 'axios';
import { PrismaService } from '@/prisma/prisma.service';
import { AiProvider } from '@generated/enums';
import { QuotaService } from './quota.service';

// DTOs (Simple inputs for the service)
interface GenerateTextOptions {
  prompt: string;
  brandKitId?: string; // Optional: specific brand voice
  tone?: string;       // Optional: override tone
}


@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private prisma: PrismaService,
    private quotaService: QuotaService,
    private aiFactory: AiFactory,
  ) {}

  // ===========================================================================
  // 📝 1. TEXT GENERATION (Captions, Ideas, Scripts)
  // ===========================================================================
  async generateCaption(
    user: any,
    workspaceId: string,
    options: GenerateTextOptions,
  ) {
    const { prompt, brandKitId, tone } = options;

    // 🛑 A. Optimistic Quota Check
    // We deduct 1 credit NOW. If it fails later, we give it back.
    await this.quotaService.checkAndIncrement(user, workspaceId, 'TEXT');

    try {
      // B. Determine Strategy (Model Selection)
      // "Rocket" users get the smart model (Claude/GPT-4)
      // Free/Business users get the fast model (Gemini Flash)
      const planTier = this.getUserPlan(user);
      
      let providerEnum: AiProvider = 'GEMINI';
      let model = 'gemini-2.5-flash'; // ⚡ Free & Fast (2026 Standard)


      // C. Build Context (Brand Voice)
      const systemPrompt = await this.buildSystemPrompt(
        workspaceId,
        brandKitId,
        tone,
      );

      // D. Execute
      const provider = this.aiFactory.getProvider(providerEnum);
      const result = await provider.generateText(prompt, systemPrompt, model);

      // E. Log Usage (Async - Fire & Forget)
      this.logUsage(user, workspaceId, 'TEXT', providerEnum, model, result.usage);

      return {
        content: result.content,
        provider: providerEnum,
        model: model,
      };
    } catch (error) {
      this.logger.error(`Text Generation Failed: ${error.message}`, error.stack);
      
      // ↩️ REFUND: AI failed, so give the user their credit back
      await this.quotaService.refundQuota(workspaceId, 'TEXT');
      
      throw new InternalServerErrorException(
        'AI service is currently unavailable. Your credits have been refunded.',
      );
    }
  }

  // ===========================================================================
  // 🖼️ 2. IMAGE GENERATION (Universal Handler)
  // ===========================================================================
  async generateImage(user: any, workspaceId: string, prompt: string) {
    // A. Check Quota
    await this.quotaService.checkAndIncrement(user, workspaceId, 'IMAGE');

    try {
      // B. Select Provider
      // Dev -> HuggingFace (Free)
      // Prod -> Replicate/Imagen (Paid)
      const provider = this.aiFactory.getImageProvider();
      const result = await provider.generateImage(prompt);

      // C. Handle Source (URL or Base64)
      // Cloudinary's upload() handles both automatically! 🤯
      const imageSource = result.urls[0];

      // D. Upload to Cloudinary (Persist the image)
      const uploadResult = await cloudinary.uploader.upload(imageSource, {
        folder: `workspaces/${workspaceId}`,
        resource_type: 'image',
      });

      // E. Save to DB
      const mediaFile = await this.prisma.mediaFile.create({
        data: {
          workspaceId,
          userId: user.userId,
          
          url: uploadResult.secure_url,
          publicId: uploadResult.public_id,
          
          filename: `ai_gen_${Date.now()}.png`,
          originalName: prompt.slice(0, 50),
          mimeType: 'image/png',
          size: BigInt(uploadResult.bytes || 1024),
          width: uploadResult.width,
          height: uploadResult.height,
          
          isAiGenerated: true,
          aiProvider: 'GEMINI', // Generic label, or dynamic if you prefer
          aiPrompt: prompt,
        },
      });

      // F. Log Usage
      this.logUsage(user, workspaceId, 'IMAGE', 'GEMINI', 'imagen-3', {
        inputTokens: 0,
        outputTokens: 1,
      });

      // Return friendly object (Convert BigInt for JSON)
      return {
        ...mediaFile,
        size: mediaFile.size.toString() 
      };

    } catch (error) {
      this.logger.error(`Image Generation Failed: ${error.message}`);
      // ↩️ REFUND
      await this.quotaService.refundQuota(workspaceId, 'IMAGE');
      throw new InternalServerErrorException('Image generation failed.');
    }
  }

  // ===========================================================================
  // 📢 3. PLATFORM VARIATIONS (One-Click Magic)
  // ===========================================================================
  async generateVariations(user: any, workspaceId: string, content: string) {
    const prompt = `
      Take this social media content: "${content}"
      Generate 4 distinct versions. Return RAW JSON only. No markdown.
      Schema:
      {
        "linkedin": "Professional, bullet points",
        "twitter": "Punchy, under 280 chars",
        "instagram": "Friendly, emojis, link in bio",
        "facebook": "Community focused"
      }
    `;

    // Reuse generateCaption (Handles quotas & logging automatically)
    const result = await this.generateCaption(user, workspaceId, { prompt });

    return this.safeJsonParse(result.content, {
      linkedin: result.content, // Fallback
      twitter: '',
      instagram: '',
      facebook: '',
    });
  }

  // ===========================================================================
  // ♻️ 4. THE REPURPOSER (URL -> Thread/Article)
  // ===========================================================================
  async repurposeContent(
    user: any,
    workspaceId: string,
    url: string,
    type: 'THREAD' | 'ARTICLE',
  ) {
    // 1. Quota Check (This is expensive, so we check carefully)
    await this.quotaService.checkAndIncrement(user, workspaceId, 'TEXT');

    try {
      // A. Scrape
      const scrapedText = await this.scrapeUrl(url);

      if (!scrapedText || scrapedText.length < 50) {
        throw new BadRequestException('Could not read text from this URL.');
      }

      // B. Build Prompt
      const truncatedText = scrapedText.slice(0, 15000); // Gemini 2.5 has huge context, so 15k is safe
      
      let prompt = '';
      if (type === 'THREAD') {
        prompt = `
          Task: Repurpose this text into a viral Twitter Thread (5-7 tweets).
          Format: JSON Array of strings. ["Tweet 1", "Tweet 2"...]
          Rules: Tweet 1 is a hook. Last Tweet is a CTA.
          Source: "${truncatedText}"
        `;
      } else {
        prompt = `
          Task: Repurpose this text into a LinkedIn Article.
          Format: HTML string with <h2> and <ul> tags.
          Source: "${truncatedText}"
        `;
      }

      // C. Generate (Use the configured provider strategy)
      // Since 'repurpose' is logic heavy, your 'generateCaption' logic 
      // will automatically pick 'Anthropic' if they are a Pro user.
      const result = await this.aiFactory.getProvider('GEMINI').generateText(prompt);

      // D. Parse Result
      if (type === 'THREAD') {
        const threadArray = this.safeJsonParse(result.content, [result.content]);
        return { thread: Array.isArray(threadArray) ? threadArray : [result.content] };
      }

      return { content: result.content };

    } catch (error) {
      await this.quotaService.refundQuota(workspaceId, 'TEXT');
      
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Repurposing failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to process URL.');
    }
  }

  // ===========================================================================
  // #️⃣ 5. HASHTAG GENERATOR
  // ===========================================================================
  async generateHashtags(user: any, workspaceId: string, content: string) {
    const prompt = `
      Analyze this post: "${content}"
      Generate 15 high-traffic, relevant hashtags.
      Return ONLY the hashtags separated by spaces (e.g. #Marketing #Growth). 
      No intro text.
    `;
    return this.generateCaption(user, workspaceId, { prompt });
  }

  // ===========================================================================
  // 🛠️ PRIVATE HELPERS
  // ===========================================================================

  private safeJsonParse(rawString: string, fallback: any) {
    try {
      const clean = rawString.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    } catch (e) {
      return fallback;
    }
  }

  private async scrapeUrl(url: string): Promise<string> {
    try {
      const { data } = await axios.get(url, {
        timeout: 5000, 
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
      });

      const $ = cheerio.load(data);
      $('script, style, nav, footer, header, iframe, .ads').remove();
      const text = $('body').find('h1, h2, h3, p, li').map((i, el) => $(el).text()).get().join('\n');
      return text.replace(/\s\s+/g, ' ').trim();
    } catch (error) {
      throw new Error('Network error or timeout accessing URL');
    }
  }

  private async buildSystemPrompt(workspaceId: string, brandKitId?: string, overrideTone?: string): Promise<string> {
    const basePrompt = 'You are an expert social media manager used by professionals.';
    
    let brandKit;
    if (brandKitId) {
      brandKit = await this.prisma.brandKit.findUnique({ where: { id: brandKitId } });
    } else {
      brandKit = await this.prisma.brandKit.findFirst({
        where: { workspaceId, isDefault: true }
      });
    }

    if (!brandKit) {
      return overrideTone 
        ? `${basePrompt} Write in a ${overrideTone} tone.` 
        : basePrompt;
    }

    let instructions = `${basePrompt}\n\nBRAND CONTEXT:\n`;
    if (brandKit.name) instructions += `Brand Name: ${brandKit.name}\n`;
    if (brandKit.brandVoice) instructions += `Voice Description: ${brandKit.brandVoice}\n`;
    
    const finalTone = overrideTone || brandKit.tone;
    if (finalTone) instructions += `Tone: ${finalTone}\n`;

    if (brandKit.guidelines && Array.isArray(brandKit.guidelines)) {
       instructions += `Do's and Don'ts: ${brandKit.guidelines.join(', ')}\n`;
    }

    return instructions;
  }

  private getUserPlan(user: any): string {
    return user.organization?.subscription?.plan?.name || 'FREE';
  }

  private async logUsage(
    user: any,
    workspaceId: string,
    type: string,
    provider: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number, cost?: number },
  ) {
    try {
      await this.prisma.aIUsage.create({
        data: {
          cost: usage.cost || 0,
          organizationId: user.organizationId,
          workspaceId,
          userId: user.userId,
          type: type as any,
          provider: provider as any,
          model,
          tokensUsed: (usage.inputTokens || 0) + (usage.outputTokens || 0),
          metadata: { input: usage.inputTokens, output: usage.outputTokens },
        },
      });
    } catch (e) {
      this.logger.error('Failed to log AI usage', e.stack);
    }
  }
}