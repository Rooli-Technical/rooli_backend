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
import { PlanAccessService } from '@/plan-access/plan-access.service';

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: AiQuotaService,
    private readonly promptBuilder: PromptBuilder,
    private readonly providerFactory: AiProviderFactory,
    private readonly scraper: ScraperService,
    private readonly postMedia: PostMediaService,
    private readonly planAccessService: PlanAccessService,
  ) {}

  async generateCaption(workspaceId: string, dto: GenerateCaptionDto) {
    // 1. Calculate cost
    const cost = this.getFeatureCost(AiFeature.CAPTION, 1);

    // 2. Wrap the entire logic
    return this.executeWithQuota(workspaceId, cost, async () => {
      const ctx = await this.getWorkspaceContext(workspaceId);
      const plan = ctx.tier;
      const limits = AI_TIER_LIMITS[plan];
      const model = limits.allowedModels[0];

      const provider = this.pickProviderForWorkspace(workspaceId);
      const textProvider = this.providerFactory.getProvider(provider);

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
        creditCost: cost, // 🚨 Logging = Billing
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
    });
  }

  async generatePlatformVariants(
    workspaceId: string,
    dto: GenerateVariantsDto,
  ) {
    const cost = this.getFeatureCost(AiFeature.VARIANTS, dto.platforms.length);

    return this.executeWithQuota(workspaceId, cost, async () => {
      const ctx = await this.getWorkspaceContext(workspaceId);
      const plan = ctx.tier;
      const limits = AI_TIER_LIMITS[plan];
      const model = limits.allowedModels[0];

      if (dto.platforms.length > limits.maxPlatforms) {
        throw new ForbiddenException(
          `Your ${plan} plan allows max ${limits.maxPlatforms} platforms at once.`,
        );
      }

      const variantsPerPlatform = Math.min(
        dto.variantsPerPlatform ?? 3,
        limits.maxVariants,
      );
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
          const user =
            `Write ${variantsPerPlatform} engaging posts about: "${dto.prompt}"\nTarget Platform: ${platform}\nReturn JSON ONLY: {"variants": ["..."]}`.trim();

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
        creditCost: cost,
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
    });
  }

  async repurposeContent(workspaceId: string, dto: RepurposeContentDto) {
    const ctx = await this.getWorkspaceContext(workspaceId);

    // 🚨 Check feature access BEFORE charging quota
    await this.planAccessService.ensureFeatureAccess(
      ctx.organizationId,
      'repurposeContent',
    ); // Or whatever the feature flag is in your DB

    if (!dto.sourceUrl && !dto.sourceText)
      throw new BadRequestException('Source URL or text required.');

    const cost = this.getFeatureCost(AiFeature.REPURPOSE, 1);

    return this.executeWithQuota(workspaceId, cost, async () => {
      let sourceText = dto.sourceText;
      if (dto.sourceUrl)
        sourceText = await this.scraper.scrapeUrl(dto.sourceUrl);

      const limits = AI_TIER_LIMITS[ctx.tier];
      const { brandKit, brandKitId } = await this.resolveBrandKit(
        workspaceId,
        dto.brandKitId,
      );
      const provider = this.pickProviderForWorkspace(workspaceId);
      const textProvider = this.providerFactory.getProvider(provider);

      const system = this.promptBuilder.buildSystemPrompt({
        brandKit,
        platform: dto.targetPlatform,
        depth: limits.brandKitDepth,
      });
      const user = this.promptBuilder.buildUserPrompt(
        `SOURCE CONTENT: ${sourceText}\nTASK: Transform into high-quality ${dto.targetPlatform} post.`,
      );

      const result = await textProvider.generateText({
        system,
        user,
        model: limits.allowedModels[0],
        temperature: 0.6,
      });

      await this.logGeneration({
        workspaceId,
        organizationId: ctx.organizationId,
        type: AiType.TEXT,
        feature: AiFeature.REPURPOSE,
        provider,
        creditCost: cost,
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
    });
  }

  async generateBulk(workspaceId: string, dto: BulkGenerateDto) {
    const ctx = await this.getWorkspaceContext(workspaceId);

    // 🚨 Check feature access BEFORE charging quota
    await this.planAccessService.ensureFeatureAccess(
      ctx.organizationId,
      'bulkAI',
    );

    const cost = this.getFeatureCost(AiFeature.BULK, dto.count);

    return this.executeWithQuota(workspaceId, cost, async () => {
      const limits = AI_TIER_LIMITS[ctx.tier];
      const { brandKit, brandKitId } = await this.resolveBrandKit(
        workspaceId,
        dto.brandKitId,
      );
      const provider = this.pickProviderForWorkspace(workspaceId);
      const textProvider = this.providerFactory.getProvider(provider);

      const system = this.promptBuilder.buildSystemPrompt({
        brandKit,
        platform: dto.platforms[0],
        depth: limits.brandKitDepth,
      });
      const user = this.promptBuilder.buildUserPrompt(
        `TOPIC: ${dto.topic}\nQUANTITY: Generate ${dto.count} distinct social media posts.\nReturn ONLY JSON: {"posts": [{"content": "...", "suggestedDay": 1}]}`,
      );

      const result = await textProvider.generateText({
        system,
        user,
        model: limits.allowedModels[0],
        temperature: 0.8,
        responseFormat: 'json',
      });
      const parsed = this.safeJson(result.text);
      const posts = parsed?.posts || [];

      await this.logGeneration({
        workspaceId,
        organizationId: ctx.organizationId,
        type: AiType.TEXT,
        feature: AiFeature.BULK,
        provider,
        creditCost: cost,
        model: result.model || limits.allowedModels[0],
        prompt: system,
        input: { topic: dto.topic, requestedCount: dto.count },
        output: { countGenerated: posts.length },
        usage: result.usage,
        brandKitId,
        postId: null,
      });

      return { posts, count: posts.length, usage: result.usage };
    });
  }

  async generatePostImage(
    workspaceId: string,
    userId: string,
    dto: { prompt: string; style?: string },
  ) {
    const cost = this.getFeatureCost(AiFeature.IMAGE, 1);

    return this.executeWithQuota(workspaceId, cost, async () => {
      const ctx = await this.getWorkspaceContext(workspaceId);
      const provider = this.pickProviderForWorkspace(workspaceId);
      const hfProvider = this.providerFactory.getProvider(
        provider,
      ) as HuggingFaceProvider;

      const enhancedPrompt = `${dto.prompt}, ${dto.style || 'digital art, high resolution, social media style, trending on artstation'}`;
      const imageBuffer = await hfProvider.generateImage(enhancedPrompt);

      const mediaFile = await this.postMedia.uploadAiGeneratedBuffer(
        userId,
        workspaceId,
        imageBuffer,
        dto.prompt,
      );

      await this.logGeneration({
        workspaceId,
        organizationId: ctx.organizationId,
        type: AiType.IMAGE,
        feature: AiFeature.IMAGE,
        provider: AiProvider.HUGGINGFACE,
        creditCost: cost,
        model: 'black-forest-labs/FLUX.1-schnell',
        prompt: enhancedPrompt,
        input: { originalPrompt: dto.prompt, style: dto.style },
        output: { mediaId: mediaFile.id, url: mediaFile.url },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 100 },
        brandKitId: null,
        postId: null,
      });

      return mediaFile;
    });
  }

  async generateHashtags(workspaceId: string, prompt: string) {
    const cost = this.getFeatureCost(AiFeature.CAPTION, 1); // Treat as a basic text generation cost

    return this.executeWithQuota(workspaceId, cost, async () => {
      const provider = this.pickProviderForWorkspace(workspaceId);
      const textProvider = this.providerFactory.getProvider(provider);

      const system = `You are a social media SEO expert. Return a JSON object with a list of 10 relevant hashtags. Format: {"hashtags": ["#tag1", "#tag2"]}`;
      const user = `Generate hashtags for this post content: "${prompt}"`;

      const result = await textProvider.generateText({
        system,
        user,
        model: 'mistralai/Mistral-7B-Instruct-v0.3',
        responseFormat: 'json',
      });
      const parsed = this.safeJson(result.text);

      // Note: Omitted logGeneration here for brevity as it's a micro-action, but you can add it if you want strict logging!
      return parsed?.hashtags || [];
    });
  }

  async optimizeContent(
    workspaceId: string,
    content: string,
    instruction: string,
  ) {
    const cost = this.getFeatureCost(AiFeature.CAPTION, 1);

    return this.executeWithQuota(workspaceId, cost, async () => {
      const provider = this.pickProviderForWorkspace(workspaceId);
      const textProvider = this.providerFactory.getProvider(provider);

      const system = `You are a professional copyeditor. Rewrite the user's text based strictly on their instruction.`;
      const user = `ORIGINAL TEXT: "${content}"\n\nINSTRUCTION: ${instruction}`;

      const result = await textProvider.generateText({
        system,
        user,
        model: 'mistralai/Mistral-7B-Instruct-v0.3',
        temperature: 0.7,
      });

      return { rewritten: result.text };
    });
  }

  async generateHolidayPost(
    workspaceId: string,
    dto: {
      holidayName: string;
      platform:
        | 'TWITTER'
        | 'X'
        | 'LINKEDIN'
        | 'INSTAGRAM'
        | 'FACEBOOK'
        | 'TIKTOK';
      brandKitId?: string;
      maxChars?: number;
    },
  ) {
    const cost = this.getFeatureCost(AiFeature.HOLIDAY_POST, 1);

    return this.executeWithQuota(workspaceId, cost, async () => {
      const ctx = await this.getWorkspaceContext(workspaceId);
      const limits = AI_TIER_LIMITS[ctx.tier];

      const { brandKit, brandKitId } = await this.resolveBrandKit(
        workspaceId,
        dto.brandKitId,
      );
      const holidayName = (dto.holidayName ?? '').trim().slice(0, 80);
      if (!holidayName)
        throw new BadRequestException('holidayName is required');

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

      const providerKey = this.pickProviderForWorkspace(workspaceId);
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

      const log = await this.logGeneration({
        workspaceId,
        organizationId: ctx.organizationId,
        type: AiType.TEXT,
        feature: AiFeature.HOLIDAY_POST,
        provider: providerKey,
        creditCost: cost,
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
    });
  }

  /**
   * 🛡️ THE AI EXECUTION WRAPPER
   * Handles atomic charging, execution, refunds on failure, and unified UX responses.
   */
  private async executeWithQuota<T>(
    workspaceId: string,
    cost: number,
    action: () => Promise<T>,
  ): Promise<T & { billing: any }> {
    // 1. Charge upfront
    const quota = await this.quota.consumeQuota(workspaceId, cost);

    try {
      // 2. Execute the AI logic
      const result = await action();

      // 3. Return the result merged with the standardized billing UI object
      return {
        ...result,
        billing: {
          creditsUsed: cost,
          remainingCredits: quota.remainingCredits,
          isNearLimit: quota.isNearLimit,
          overageIncurred: quota.overageIncurred,
        },
      };
    } catch (error) {
      // 4. Atomic Refund if the AI provider crashes
      await this.quota.refundQuota(workspaceId, cost);

      if (error instanceof HttpException) throw error;
      console.error('AI Execution Error:', error);
      throw new ServiceUnavailableException(
        'AI service is temporarily unavailable. Please try again.',
      );
    }
  }

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
    const log = await this.prisma.aiGeneration.create({
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
    return log;
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

    const tier = (ws.organization?.subscription?.plan?.tier ?? 'BUSINESS') as
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

  private getFeatureCost(
    feature: AiFeature | string,
    count: number = 1,
  ): number {
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
