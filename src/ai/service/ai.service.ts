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
import { AI_TIER_LIMITS } from '../constants/ai.constant';
import { ScraperService } from './scraper.service';
import { BulkGenerateDto } from '../dto/bulk-generate.dto';
import { RepurposeContentDto } from '../dto/repurpose-content.dto';
import { TextGenResult } from '../interfaces/ai-provider.interface';

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: AiQuotaService,
    private readonly promptBuilder: PromptBuilder,
    private readonly providerFactory: AiProviderFactory,
    private readonly scraper: ScraperService,
  ) {}

  // -----------------------------
  // Public API
  // -----------------------------

  async generateCaption(
    workspaceId: string,
    userId: string,
    dto: GenerateCaptionDto,
  ) {
    try {
      const ctx = await this.getWorkspaceContext(workspaceId);
      const plan = ctx.tier;
      const limits = AI_TIER_LIMITS[plan];
      const model = limits.allowedModels[0];

      const provider = this.pickProviderForWorkspace(workspaceId);
      const textProvider = this.providerFactory.getTextProvider(provider);

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
        maxTokens: 400,
        responseFormat: 'text',
      });

      // Optionally create a DRAFT post
      let postId: string | null = null;
      if (dto.saveAsDraftPost) {
        postId = await this.createDraftPost(workspaceId, userId, {
          content: result.text,
          // you can store platform target later as destinations
        });
      }

    await this.logGeneration({
  workspaceId,
  organizationId: ctx.organizationId,
  type: AiType.TEXT,
  feature: AiFeature.CAPTION,
  provider,
  model: result.model ?? model,
  prompt: system + '\n\nUSER:\n' + user,
  input: { platform, maxChars: dto.maxChars, tone: dto.tone, brandKitId },
  output: { text: result.text },
  usage: result.usage,
  brandKitId,
  postId,
});
      return {
        text: result.text,
        provider: result.provider ?? provider,
        model: result.model,
        usage: result.usage ?? null,
        postId,
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
    userId: string,
    dto: GenerateVariantsDto,
  ) {
    try{
    const ctx = await this.getWorkspaceContext(workspaceId);
    const plan = ctx.tier;
    const limits = AI_TIER_LIMITS[plan];
    const model = limits.allowedModels[0];

    // ⛔️ GATES
    if (dto.platforms.length > limits.maxPlatforms) {
      throw new ForbiddenException(
        `Your ${plan} plan allows max ${limits.maxPlatforms} platforms at once.`,
      );
    }

    const variantsPerPlatform = Math.min(
      dto.variantsPerPlatform ?? 3,
      limits.maxVariants,
    );

    await this.quota.assertCanUse(workspaceId, AiFeature.VARIANTS);

    const { brandKit, brandKitId } = await this.resolveBrandKit(
      workspaceId,
      dto.brandKitId,
    );

    const provider = this.pickProviderForWorkspace(workspaceId);
    const textProvider = this.providerFactory.getTextProvider(provider);

    const outputs = await Promise.all(
      dto.platforms.map(async (platform) => {
        const system = this.promptBuilder.buildSystemPrompt({
          brandKit,
          platform,
          depth: limits.brandKitDepth,
        });

        const user = this.promptBuilder.buildUserPrompt(
          `
${dto.prompt}

Return JSON ONLY in this format:
{"variants": ["v1", "v2", "v3"]}
      `.trim(),
        );

        const res = await textProvider.generateText({
          system,
          user,
          model,
          temperature: 0.8,
          maxTokens: 700,
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

    // Optional: create a single draft + overrides
    let postId: string | null = null;
    if (dto.saveAsDraftPost) {
      const basePlatform = dto.platforms[0] ?? 'LINKEDIN';
      const base =
        outputs.find((o) => o.platform === basePlatform)?.variants?.[0] ??
        outputs[0]?.variants?.[0] ??
        '';

      postId = await this.createDraftPost(workspaceId, userId, {
        content: base,
        overrides: outputs.reduce(
          (acc, o) => {
            acc[o.platform] = o.variants[0] ?? '';
            return acc;
          },
          {} as Record<string, string>,
        ),
      });
    }

    const usage = this.mergeUsage(outputs.map((o) => o.raw));

    await this.logGeneration({
      workspaceId,
      organizationId: ctx.organizationId,
      type: AiType.TEXT,
      feature: AiFeature.VARIANTS,
      provider,
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
      postId,
    });

    return {
      variants: outputs.map((o) => ({
        platform: o.platform,
        variants: o.variants,
      })),
      usage,
      postId,
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
  userId: string,
  dto: RepurposeContentDto, // Should contain { sourceUrl, sourceText, targetPlatform }
) {
  const ctx = await this.getWorkspaceContext(workspaceId);
  const plan = ctx.tier;
  const limits = AI_TIER_LIMITS[plan];

  // 1. Plan Gate
  if (!limits.canRepurpose) {
    throw new ForbiddenException('Content Repurposing is available on Business and Rocket plans.');
  }

  if (!dto.sourceUrl && !dto.sourceText) {
  throw new BadRequestException('Either a source URL or source text must be provided.');
}

  // 2. Quota Check
  await this.quota.assertCanUse(workspaceId, AiFeature.REPURPOSE);

  // 2. SCRAPE THE CONTENT
  let sourceText = dto.sourceText;
  if (dto.sourceUrl) {
    // Convert the URL into clean text
    sourceText = await this.scraper.scrapeUrl(dto.sourceUrl);
  }

  const { brandKit, brandKitId } = await this.resolveBrandKit(workspaceId, dto.brandKitId);
  const provider = this.pickProviderForWorkspace(workspaceId);
  const textProvider = this.providerFactory.getTextProvider(provider);

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
      model: result.model || limits.allowedModels[0],
      prompt: system,
      input: { source: dto.sourceUrl ? 'URL' : 'TEXT', platform: dto.targetPlatform },
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
  userId: string,
  dto: BulkGenerateDto, // { topic, count: 10, platforms: ['LINKEDIN'], brandKitId }
) {
  const ctx = await this.getWorkspaceContext(workspaceId);
  const plan = ctx.tier;
  const limits = AI_TIER_LIMITS[plan];

  // 1. GATE: Only Rocket can use Bulk
  if (!limits.canBulk) {
    throw new ForbiddenException('Bulk Generation is exclusive to the Rocket Plan.');
  }

  // 2. QUOTA: Check if they have enough credits for the WHOLE batch
  // Note: We count the batch as '1 request' or 'N requests' based on your business rule.
  // Here we check once to see if they are generally allowed.
  await this.quota.assertCanUse(workspaceId, AiFeature.BULK);

  const { brandKit, brandKitId } = await this.resolveBrandKit(workspaceId, dto.brandKitId);
  const provider = this.pickProviderForWorkspace(workspaceId);
  const textProvider = this.providerFactory.getTextProvider(provider);

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
  // -----------------------------
  // Internals
  // -----------------------------

  private async getPlanContext(
    workspaceId: string,
  ): Promise<'CREATOR' | 'BUSINESS' | 'ROCKET'> {
    const ctx = await this.getWorkspaceContext(workspaceId);
    return ctx.tier;
  }

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
    return AiProvider.GEMINI;
  }
  private async getOrgId(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!ws) throw new NotFoundException('Workspace not found');
    return ws.organizationId;
  }

  private async createDraftPost(
    workspaceId: string,
    userId: string,
    args: { content: string; overrides?: Record<string, string> },
  ): Promise<string> {
    const post = await this.prisma.post.create({
      data: {
        workspaceId,
        // you likely have authorId/createdById – adjust to your schema:
        createdById: userId as any,
        status: 'DRAFT' as any,
        content: args.content,
        // store overrides in a JSON column if you have one, otherwise skip
        metadata: args.overrides
          ? ({ aiOverrides: args.overrides } as any)
          : undefined,
      } as any,
      select: { id: true },
    });

    return post.id;
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

    await this.prisma.aiGeneration.create({
      data: {
        organizationId: args.organizationId,
        workspaceId: args.workspaceId,

        type: args.type as any,
        feature: args.feature as any,

        provider: args.provider as any,
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
}
