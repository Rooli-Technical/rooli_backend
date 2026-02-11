import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AiFeature, AiProvider, AiType } from '@generated/enums';
import { Prisma } from '@generated/client';
import { GenerateCaptionDto } from '../dto/generate-caption.dto';
import { GenerateVariantsDto } from '../dto/generate-variant.dto';
import { PromptBuilder } from './prompt.service';
import { AiProviderFactory } from './ai.factory';
import { AiQuotaService } from './quota.service';
import { AI_COSTS, AI_TIER_LIMITS } from '../constants/ai.constant';
import { ScraperService } from './scraper.service';
import { BulkGenerateDto } from '../dto/bulk-generate.dto';
import { RepurposeContentDto } from '../dto/repurpose-content.dto';
import { TextGenResult } from '../interfaces/ai-provider.interface';
import { PostMediaService } from '@/post-media/post-media.service';
import { HuggingFaceProvider } from '../providers/huggingface.provider';

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: AiQuotaService,
    private readonly promptBuilder: PromptBuilder,
    private readonly providerFactory: AiProviderFactory,
    private readonly scraper: ScraperService,
    private readonly postMedia: PostMediaService,
  ) {}

  async generateCaption(workspaceId: string, dto: GenerateCaptionDto) {
    try {
      const ctx = await this.getWorkspaceContext(workspaceId);
      const plan = ctx.tier;
      const limits = AI_TIER_LIMITS[plan];
      const model = limits.allowedModels[0];

      const provider = this.pickProviderForWorkspace(workspaceId);
      const textProvider = this.providerFactory.getProvider(provider);

      await this.quota.assertCanUse(workspaceId, AiFeature.CAPTION);

      const { brandKit, brandKitId } = await this.resolveBrandKit(
        workspaceId,
        dto.brandKitId,
      );

      const platform = dto.platform ?? 'LINKEDIN';
      const system = this.promptBuilder.buildSystemPrompt({
        brandKit,
        platform,
        depth: limits.brandKitDepth,
      });

      const user = this.promptBuilder.buildUserPrompt(dto.prompt);

      const result = await textProvider.generateText({
        system,
        user,
        model,
        temperature: 0.7,
        maxTokens: 500,
        responseFormat: 'text',
      });

      const log = await this.logGeneration({
        workspaceId,
        organizationId: ctx.organizationId,
        type: AiType.TEXT,
        feature: AiFeature.CAPTION,
        provider,
        creditCost: this.getFeatureCost(AiFeature.CAPTION, 1),
        model: result.model ?? model,
        prompt: system + '\n\nUSER:\n' + user,
        input: { platform, maxChars: dto.maxChars, tone: dto.tone, brandKitId },
        output: { text: result.text },
        usage: result.usage,
        brandKitId,
        postId: null,
      });
      return {
        text: result.text,
        provider: result.provider ?? provider,
        model: result.model,
        usage: result.usage ?? null,
        generationId: log?.id,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      console.log(error);
      throw new ServiceUnavailableException(
        'AI service is temporarily unavailable. Please try again.',
      );
    }
  }

  async generatePlatformVariants(
    workspaceId: string,
    dto: GenerateVariantsDto,
  ) {
    try {
      const ctx = await this.getWorkspaceContext(workspaceId);
      const plan = ctx.tier;
      const limits = AI_TIER_LIMITS[plan];
      const model = limits.allowedModels[0];
      const platformCount = dto.platforms.length;

      // GATES
      if (dto.platforms.length > limits.maxPlatforms) {
        throw new ForbiddenException(
          `Your ${plan} plan allows max ${limits.maxPlatforms} platforms at once.`,
        );
      }

      const variantsPerPlatform = Math.min(
        dto.variantsPerPlatform ?? 3,
        limits.maxVariants,
      );

      await this.quota.assertCanUse(workspaceId, AiFeature.VARIANTS, platformCount);

      const { brandKit, brandKitId } = await this.resolveBrandKit(
        workspaceId,
        dto.brandKitId,
      );

      const provider = this.pickProviderForWorkspace(workspaceId);
      const textProvider = this.providerFactory.getProvider(provider);
      const outputs = await Promise.all(
        dto.platforms.map(async (platform) => {
          const system = this.promptBuilder.buildSystemPrompt({
            brandKit,
            platform,
            depth: limits.brandKitDepth,
          });

          const user = `
      Write ${variantsPerPlatform} engaging posts about: "${dto.prompt}"
      Target Platform: ${platform}
      
      Return JSON ONLY:
      {
        "variants": ["First post text...", "Second post text..."]
      }
    `.trim();

          const res = await textProvider.generateText({
            system,
            user,
            model,
            temperature: 0.8,
            maxTokens: 1000,
            responseFormat: 'json',
          });

          const parsed = this.safeJson(res.text);
          const variants = Array.isArray(parsed?.variants)
            ? parsed.variants.slice(0, variantsPerPlatform)
            : [];

          // fallback if model ignored JSON
          if (variants.length === 0) {
            const fallback = res.text
              .split('\n---\n')
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, variantsPerPlatform);
            return { platform, variants: fallback, raw: res };
          }

          return { platform, variants, raw: res };
        }),
      );
      const usage = this.mergeUsage(outputs.map((o) => o.raw));

      const log = await this.logGeneration({
        workspaceId,
        organizationId: ctx.organizationId,
        type: AiType.TEXT,
        feature: AiFeature.VARIANTS,
        provider,
        creditCost: this.getFeatureCost(AiFeature.VARIANTS, platformCount),
        model: outputs[0]?.raw.model ?? model,
        prompt: null,
        input: {
          platforms: dto.platforms,
          variantsPerPlatform,
          brandKitId,
          plan,
        },
        output: {
          variants: outputs.map((o) => ({
            platform: o.platform,
            variants: o.variants,
          })),
        },
        usage,
        brandKitId,
        postId: null,
      });

      return {
        variants: outputs.map((o) => ({
          platform: o.platform,
          variants: o.variants,
        })),
        usage,
        generationId: log.id,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      console.log(error);
      throw new ServiceUnavailableException(
        'AI service is temporarily unavailable. Please try again.',
      );
    }
  }

  /**
   * REPURPOSE CONTENT (Business & Rocket Only)
   * Turns a URL or Text into a specific format (Thread, Carousel)
   */
  async repurposeContent(
    workspaceId: string,
    dto: RepurposeContentDto, // Should contain { sourceUrl, sourceText, targetPlatform }
  ) {
    const ctx = await this.getWorkspaceContext(workspaceId);
    const plan = ctx.tier;
    const limits = AI_TIER_LIMITS[plan];

    // 1. Plan Gate
    if (!limits.canRepurpose) {
      throw new ForbiddenException(
        'Content Repurposing is available on Business and Rocket plans.',
      );
    }

    if (!dto.sourceUrl && !dto.sourceText) {
      throw new BadRequestException(
        'Either a source URL or source text must be provided.',
      );
    }

    // 2. Quota Check
    await this.quota.assertCanUse(workspaceId, AiFeature.REPURPOSE);

    // 2. SCRAPE THE CONTENT
    let sourceText = dto.sourceText;
    if (dto.sourceUrl) {
      // Convert the URL into clean text
      sourceText = await this.scraper.scrapeUrl(dto.sourceUrl);
    }

    const { brandKit, brandKitId } = await this.resolveBrandKit(
      workspaceId,
      dto.brandKitId,
    );
    const provider = this.pickProviderForWorkspace(workspaceId);
    const textProvider = this.providerFactory.getProvider(provider);

    // 3. Prompt Construction
    const system = this.promptBuilder.buildSystemPrompt({
      brandKit,
      platform: dto.targetPlatform,
      depth: limits.brandKitDepth,
    });

    // Specifically instruct the AI to "Summarize and Transform"
    const user = this.promptBuilder.buildUserPrompt(`
    SOURCE CONTENT: ${sourceText}
    
    TASK: Transform the source content above into a high-quality ${dto.targetPlatform} post. 
    Maintain the core message but adapt the hook and structure for maximum engagement.
  `);

    try {
      const result = await textProvider.generateText({
        system,
        user,
        model: limits.allowedModels[0],
        temperature: 0.6, // Lower temperature for better factual consistency
      });

      // 4. Log Success
      await this.logGeneration({
        workspaceId,
        organizationId: ctx.organizationId,
        type: AiType.TEXT,
        feature: AiFeature.REPURPOSE,
        provider,
        creditCost: this.getFeatureCost(AiFeature.REPURPOSE, 1),
        model: result.model || limits.allowedModels[0],
        prompt: system,
        input: {
          source: dto.sourceUrl ? 'URL' : 'TEXT',
          platform: dto.targetPlatform,
        },
        output: { text: result.text },
        usage: result.usage,
        brandKitId,
        postId: null,
      });

      return result;
    } catch (error) {
      console.error(error);
      throw new ServiceUnavailableException('Failed to repurpose content.');
    }
  }

  /**
   * BULK GENERATION (Rocket Only)
   * "Generate 30 posts for next month"
   */
  async generateBulk(
    workspaceId: string,
    dto: BulkGenerateDto, // { topic, count: 10, platforms: ['LINKEDIN'], brandKitId }
  ) {
    const ctx = await this.getWorkspaceContext(workspaceId);
    const plan = ctx.tier;
    const limits = AI_TIER_LIMITS[plan];

    // 1. GATE: Only Rocket can use Bulk
    if (!limits.canBulk) {
      throw new ForbiddenException(
        'Bulk Generation is exclusive to the Rocket Plan.',
      );
    }

    // 2. QUOTA: Check if they have enough credits for the WHOLE batch
    // Note: We count the batch as '1 request' or 'N requests' based on your business rule.
    // Here we check once to see if they are generally allowed.
    await this.quota.assertCanUse(workspaceId, AiFeature.BULK);

    const { brandKit, brandKitId } = await this.resolveBrandKit(
      workspaceId,
      dto.brandKitId,
    );
    const provider = this.pickProviderForWorkspace(workspaceId);
    const textProvider = this.providerFactory.getProvider(provider);

    // 3. PROMPT: Instruct AI to return a specific JSON array
    const system = this.promptBuilder.buildSystemPrompt({
      brandKit,
      platform: dto.platforms[0], // Use primary platform for style
      depth: limits.brandKitDepth,
    });

    const user = this.promptBuilder.buildUserPrompt(`
    TOPIC: ${dto.topic}
    QUANTITY: Generate ${dto.count} distinct social media posts.
    
    Return ONLY a JSON object with this structure:
    {
      "posts": [
        { "content": "Post 1 text here...", "suggestedDay": 1 },
        { "content": "Post 2 text here...", "suggestedDay": 2 }
      ]
    }
  `);

    try {
      const result = await textProvider.generateText({
        system,
        user,
        model: limits.allowedModels[0],
        temperature: 0.8, // Slightly higher for variety in bulk
        responseFormat: 'json',
      });

      const parsed = this.safeJson(result.text);
      const posts = parsed?.posts || [];

      // 4. LOGGING: Record the bulk success
      await this.logGeneration({
        workspaceId,
        organizationId: ctx.organizationId,
        type: AiType.TEXT,
        feature: AiFeature.BULK,
        provider,
        creditCost: this.getFeatureCost(AiFeature.BULK, dto.count),
        model: result.model || limits.allowedModels[0],
        prompt: system,
        input: { topic: dto.topic, requestedCount: dto.count },
        output: { countGenerated: posts.length },
        usage: result.usage,
        brandKitId,
        postId: null,
      });

      return {
        posts,
        count: posts.length,
        usage: result.usage,
      };
    } catch (error) {
      console.error('Bulk Generation Error:', error);
      throw new ServiceUnavailableException('Failed to generate bulk content.');
    }
  }

  async generatePostImage(
    workspaceId: string,
    userId: string,
    dto: { prompt: string; style?: string },
  ) {
    const ctx = await this.getWorkspaceContext(workspaceId);

    if (ctx.tier === 'CREATOR') {
      throw new ForbiddenException(
        'AI Image generation is available on Business and Rocket plans.',
      );
    }

    // 1. Quota Check
    await this.quota.assertCanUse(workspaceId, AiFeature.IMAGE);

    // 2. Get Hugging Face Provider
    const provider = this.pickProviderForWorkspace(workspaceId);
    const hfProvider = this.providerFactory.getProvider(
      provider,
    ) as HuggingFaceProvider;

    try {
      // 3. Generate the Image Buffer
      // We enhance the prompt slightly for social media quality
      const enhancedPrompt = `${dto.prompt}, ${dto.style || 'digital art, high resolution, social media style, trending on artstation'}`;

      const imageBuffer = await hfProvider.generateImage(enhancedPrompt);

      const mediaFile = await this.postMedia.uploadAiGeneratedBuffer(
        userId,
        workspaceId,
        imageBuffer,
        dto.prompt,
      );

      // 5. Log the AI Generation for Quota Tracking
      await this.logGeneration({
        workspaceId,
        organizationId: ctx.organizationId,
        type: AiType.IMAGE,
        feature: AiFeature.IMAGE,
        provider: AiProvider.HUGGINGFACE,
        creditCost: this.getFeatureCost(AiFeature.IMAGE, 1),
        model: 'black-forest-labs/FLUX.1-schnell', // Your default image model
        prompt: enhancedPrompt,
        input: { originalPrompt: dto.prompt, style: dto.style },
        output: { mediaId: mediaFile.id, url: mediaFile.url },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 100 }, // Standardize image cost
        brandKitId: null,
        postId: null,
      });

      return mediaFile;
    } catch (error) {
      console.error('AI Image Flow Error:', error);
      throw new ServiceUnavailableException(
        'Failed to generate or save AI image.',
      );
    }
  }
  /**
   * 1. HASHTAG GENERATOR
   * Generates relevant hashtags based on a caption or topic
   */
  async generateHashtags(workspaceId: string, prompt: string) {
    // Quota check (Light usage)
    await this.quota.assertCanUse(workspaceId, AiFeature.CAPTION);

    const provider = this.pickProviderForWorkspace(workspaceId);
    const textProvider = this.providerFactory.getProvider(provider);

    const system = `You are a social media SEO expert. Return a JSON object with a list of 30 relevant hashtags. Format: {"hashtags": ["#tag1", "#tag2"]}`;
    const user = `Generate hashtags for this post content: "${prompt}"`;

    const result = await textProvider.generateText({
      system,
      user,
      model: 'mistralai/Mistral-7B-Instruct-v0.3', // Good for lists
      responseFormat: 'json',
    });

    const parsed = this.safeJson(result.text);
    return parsed?.hashtags || [];
  }

  /**
   * 2. CONTENT OPTIMIZER (Tone/Grammar/Hook)
   * "Make this funnier" or "Fix grammar"
   */
  async optimizeContent(
    workspaceId: string,
    content: string,
    instruction: string,
  ) {
    await this.quota.assertCanUse(workspaceId, AiFeature.CAPTION);

    const provider = this.pickProviderForWorkspace(workspaceId);
    const textProvider = this.providerFactory.getProvider(provider);

    const system = `You are a professional copyeditor. Rewrite the user's text based strictly on their instruction.`;
    const user = `ORIGINAL TEXT: "${content}"\n\nINSTRUCTION: ${instruction} (e.g., make it punchy, fix grammar, make it viral)`;

    const result = await textProvider.generateText({
      system,
      user,
      model: 'mistralai/Mistral-7B-Instruct-v0.3',
      temperature: 0.7,
    });

    return { rewritten: result.text };
  }

  async generateHolidayPost(
    workspaceId: string,
    dto: {
      holidayName: string;
      platform: 'TWITTER' | 'X' | 'LINKEDIN' | 'INSTAGRAM' | 'FACEBOOK';
      brandKitId?: string;
      maxChars?: number;
    },
  ) {
    const ctx = await this.getWorkspaceContext(workspaceId);
    const plan = ctx.tier;
    const limits = AI_TIER_LIMITS[plan];

    // 1) Quota (choose ONE feature name consistently)
    await this.quota.assertCanUse(workspaceId, AiFeature.HOLIDAY_POST);

    // 2) Brand kit
    const { brandKit, brandKitId } = await this.resolveBrandKit(
      workspaceId,
      dto.brandKitId,
    );

    // 3) Sanitize holiday name (treat as data)
    const holidayName = (dto.holidayName ?? '').trim().slice(0, 80);
    if (!holidayName) throw new BadRequestException('holidayName is required');

    // 4) Build prompts (layer holiday instructions ON TOP of normal system)
    const baseSystem = this.promptBuilder.buildSystemPrompt({
      brandKit,
      platform: dto.platform,
      maxChars: dto.maxChars,
      depth: limits.brandKitDepth,
    });

    const holidaySystem =
      this.promptBuilder.buildHolidayAddonPrompt(holidayName);

    const system = `${baseSystem}\n\n---\n${holidaySystem}`;
    const user = this.promptBuilder.buildUserPrompt(
      `Write a ${dto.platform} post for ${holidayName}.`,
    );

    // 5) Provider
    const providerKey = this.pickProviderForWorkspace(workspaceId); // e.g. HUGGINGFACE
    const textProvider = this.providerFactory.getProvider(providerKey);

    const model = limits.allowedModels[0];

    const result = await textProvider.generateText({
      system,
      user,
      model,
      temperature: 0.8,
      maxTokens: 600,
      responseFormat: 'text',
    });

    // 6) Log
    const log = await this.logGeneration({
      workspaceId,
      organizationId: ctx.organizationId,
      type: AiType.TEXT,
      feature: AiFeature.HOLIDAY_POST,
      provider: providerKey,
      creditCost: this.getFeatureCost(AiFeature.HOLIDAY_POST, 1),
      model: result.model ?? model,
      prompt: system + '\n\nUSER:\n' + user,
      input: { holidayName, platform: dto.platform, brandKitId },
      output: { text: result.text },
      usage: result.usage,
      brandKitId,
      postId: null,
    });

    return {
      text: result.text,
      provider: result.provider ?? providerKey,
      model: result.model ?? model,
      usage: result.usage ?? null,
      generationId: log.id,
    };
  }

  /**
   * 3. AI INSIGHTS (Best Time to Post)
   * Analyzes past posts (if any) or gives general best practices
   */
  // async getPostingRecommendations(workspaceId: string, platform: string) {
  //   // 1. Fetch last 20 posts with analytics from DB
  //   const history = await this.prisma.post.findMany({
  //     where: { workspaceId, platform: platform as any, status: 'PUBLISHED' },
  //     select: { publishedAt: true, metrics: true },
  //     take: 20,
  //   });

  //   // 2. If no history, return "Cold Start" general data
  //   if (history.length < 5) {
  //     return {
  //       recommendation: "General Best Times",
  //       times: ["09:00 AM", "12:00 PM", "06:00 PM"],
  //       reason: "Not enough data yet. These are global peak times."
  //     };
  //   }

  //   // 3. If history exists, ask AI to analyze patterns
  //   const provider = this.pickProviderForWorkspace(workspaceId);
  //   const textProvider = this.providerFactory.getProvider(provider);

  //   // Simplistic serialization of history for the prompt
  //   const dataSummary = history.map(h =>
  //     `Time: ${h.publishedAt}, Likes: ${(h.metrics as any)?.likes || 0}`
  //   ).join('\n');

  //   const result = await textProvider.generateText({
  //     system: "You are a data analyst.",
  //     user: `Analyze this post performance data and recommend the best 3 times to post next. Data:\n${dataSummary}`,
  //     model: 'mistralai/Mistral-7B-Instruct-v0.3',
  //   });

  //   return { analysis: result.text };
  // }
  // -----------------------------
  // Internals
  // -----------------------------

  private async resolveBrandKit(workspaceId: string, brandKitId?: string) {
    // 1) If brandKitId provided, verify it belongs to the workspace
    if (brandKitId) {
      const kit = await this.prisma.brandKit.findUnique({
        where: { id: brandKitId },
      });
      if (!kit || kit.workspaceId !== workspaceId) {
        throw new BadRequestException('Invalid brandKitId for this workspace');
      }
      return { brandKit: kit, brandKitId: kit.id };
    }

    // 2) Else fetch the workspace’s kit (1:1 by workspaceId)
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
    });
    // If you require it to exist, throw. Or auto-create a default in onboarding.
    if (!kit) return { brandKit: null, brandKitId: null };
    return { brandKit: kit, brandKitId: kit.id };
  }

  private pickProviderForWorkspace(_workspaceId: string): AiProvider {
    return AiProvider.HUGGINGFACE;
  }

  private mergeUsage(results: Array<TextGenResult | undefined | null>) {
    const input = results.reduce((s, r) => s + (r?.usage?.inputTokens ?? 0), 0);
    const output = results.reduce(
      (s, r) => s + (r?.usage?.outputTokens ?? 0),
      0,
    );
    const total = results.reduce((s, r) => s + (r?.usage?.totalTokens ?? 0), 0);
    const costUsd = results.reduce((s, r) => s + (r?.usage?.costUsd ?? 0), 0);

    return {
      inputTokens: input || undefined,
      outputTokens: output || undefined,
      totalTokens: total || input + output || undefined,
      costUsd: costUsd || undefined,
    };
  }

  private async logGeneration(args: {
    organizationId: string;
    workspaceId: string;
    type: AiType;
    feature: AiFeature;
    provider: AiProvider;
    creditCost: number;
    model: string;
    prompt: string | null;
    input: any;
    output: any;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    };
    brandKitId: string | null;
    postId: string | null;
  }) {
    const inputTokens = args.usage?.inputTokens;
    const outputTokens = args.usage?.outputTokens;
    const totalTokens =
      args.usage?.totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0);
    const costUsd = args.usage?.costUsd;
    return await this.prisma.aiGeneration.create({
      data: {
        organizationId: args.organizationId,
        workspaceId: args.workspaceId,

        type: args.type as any,
        feature: args.feature as any,

        provider: args.provider as any,
        creditCost: args.creditCost,
        model: args.model,

        prompt: args.prompt ?? undefined,
        input: args.input as Prisma.JsonValue,
        output: args.output as Prisma.JsonValue,

        inputTokens,
        outputTokens,
        costUsd,
        

        brandKitId: args.brandKitId ?? undefined,
        postId: args.postId ?? undefined,

        metadata: { totalTokens } as Prisma.JsonValue,
      } as any,
    });
  }

  private async getWorkspaceContext(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        organizationId: true,
        organization: {
          select: {
            subscription: { select: { plan: { select: { tier: true } } } },
          },
        },
      },
    });

    if (!ws) throw new NotFoundException('Workspace not found');

    const tier = (ws.organization?.subscription?.plan?.tier ?? 'CREATOR') as
      | 'CREATOR'
      | 'BUSINESS'
      | 'ROCKET';

    return { workspaceId: ws.id, organizationId: ws.organizationId, tier };
  }

  private safeJson(text: string) {
    try {
      return JSON.parse(text);
    } catch {
      // try to salvage JSON from messy output
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }

  private getFeatureCost(feature: AiFeature | string, count: number = 1): number {
    const baseCost = AI_COSTS[feature] ?? 1; 

    // For features like 'BULK', you might want to multiply cost by count
    // For single actions, count defaults to 1.
    if (feature === 'BULK' || feature === 'VARIANTS') {
       // Example logic: Base cost + small fee per additional item
       return baseCost + (count > 1 ? (count - 1) * 0.5 : 0);
    }

    return baseCost * count;
  }
}
