import { PrismaService } from '@/prisma/prisma.service';
import { ConnectionStatus, Platform, Prisma } from '@generated/client';
import { Injectable, BadRequestException } from '@nestjs/common';
import * as twitter from 'twitter-text';
import { PlatformRulesService } from './platform-rules.service';
import { CreatePostDto } from '../dto/request/create-post.dto';
import { MediaItem, ThreadNode } from '../interfaces/post.interface';

@Injectable()
export class DestinationBuilder {
  constructor(
    private platformRules: PlatformRulesService,
    private prisma: PrismaService,
  ) {}

  private buildOverrideMap(overrides?: { socialProfileId: string; content: string }[]) {
    const map = new Map<string, string>();
    overrides?.forEach((o) => map.set(o.socialProfileId, o.content));
    return map;
  }

  /**
   * PHASE 1: PREPARATION (outside transaction)
   *
   * Rules:
   * - Fetch profiles and ensure they belong to workspace
   * - Fetch media metadata for master + thread media
   * - For TWITTER:
   *    - Tweet 1 content can be overridden per profile (override affects only Tweet 1)
   *    - If dto.threads exists => validate tweet1 + each reply; DO NOT autosplit
   *    - Else => autosplit tweet1 if needed, store replies in metadata
   * - For others: validate and transform with PlatformRulesService
   *
   * Output payload format:
   *   {
   *     socialProfileId,
   *     platform,
   *     status,
   *     contentOverride,
   *     metadata?: { thread?: ThreadNode[] }
   *   }
   */
  async preparePayloads(workspaceId: string, dto: CreatePostDto): Promise<any[]> {
    // 1) Fetch profiles
    const profiles = await this.prisma.socialProfile.findMany({
      where: { id: { in: dto.socialProfileIds, }, workspaceId, status: ConnectionStatus.CONNECTED },
      select: { id: true, platform: true, name: true,  },
    });

    if (profiles.length !== dto.socialProfileIds.length) {
      throw new BadRequestException('One or more profiles do not belong to this workspace.');
    }

    // 2) Overrides
    const overrideMap = this.buildOverrideMap(dto.overrides);

    // 3) Collect ALL media IDs (master + thread replies)
    const allMediaIds = new Set<string>(dto.mediaIds ?? []);
    dto.threads?.forEach((t) => t.mediaIds?.forEach((id) => allMediaIds.add(id)));

    // 4) Fetch media metadata and build lookup map
    const dbMedia = allMediaIds.size
      ? await this.prisma.mediaFile.findMany({
          where: { id: { in: Array.from(allMediaIds) } },
          select: { id: true, url: true, width: true, height: true, mimeType: true, size: true, duration: true },
        })
      : [];

    const mediaMap = new Map(dbMedia.map((m) => [m.id, { ...m, size: Number(m.size) }]));

    // Helpers
    const resolveMedia = (ids?: string[]) =>
      (ids ?? []).map((id) => mediaMap.get(id)).filter(Boolean) as MediaItem[];

    const hasExplicitThreads = Array.isArray(dto.threads) && dto.threads.length > 0;

    type ThreadNode = {
      content: string;
      mediaIds?: string[];
      targetProfileIds?: string[];
    };

    const explicitThread: ThreadNode[] = hasExplicitThreads
      ? dto.threads!
          .map((t) => ({
            content: (t?.content ?? '').trim(),
            mediaIds: t?.mediaIds ?? [],
            targetProfileIds: t?.targetProfileIds ?? [],
          }))
          .filter((t) => t.content.length > 0)
      : [];

    // 5) Build payload per profile
    const payloads: any[] = [];
    const errors: string[] = [];

    for (const profile of profiles) {
      const contentBase = (dto.content ?? '').trim();
      const override = overrideMap.get(profile.id);
      const tweet1Content = (override ?? contentBase).trim();

      try {
        // -------------------------
        // TWITTER (special handling)
        // -------------------------
        if (profile.platform === 'TWITTER') {
          // Tweet 1 uses master media
          const tweet1Media = resolveMedia(dto.mediaIds);

          if (hasExplicitThreads) {
            // Validate tweet 1
            this.validateSingleTweetOrThrow(tweet1Content, tweet1Media);

            // Validate each reply WITH its own media
            for (let i = 0; i < explicitThread.length; i++) {
              const node = explicitThread[i];
              const replyMedia = resolveMedia(node.mediaIds);

              try {
                this.validateSingleTweetOrThrow(node.content, replyMedia);
              } catch (e: any) {
                throw new BadRequestException(`Thread item #${i + 1}: ${e?.message ?? 'Invalid tweet.'}`);
              }
            }

            payloads.push({
              socialProfileId: profile.id,
              platform: profile.platform,
              status: 'SCHEDULED',
              contentOverride: tweet1Content,
              metadata: explicitThread.length ? { thread: explicitThread } : undefined,
            });
            continue;
          }

          // No explicit threads => autosplit tweet 1 if needed
          const result = this.platformRules.validateAndTransform(
            tweet1Content,
            Platform.TWITTER,
            tweet1Media,
          );

          const autoThread: ThreadNode[] = (result.threadChain ?? []).map((c) => ({
            content: c,
            mediaIds: [],         // autosplit replies never carry media
            targetProfileIds: [], // applies to all selected twitter profiles
          }));

          payloads.push({
            socialProfileId: profile.id,
            platform: profile.platform,
            status: 'SCHEDULED',
            contentOverride: result.finalContent,
            metadata: autoThread.length ? { thread: autoThread } : undefined,
          });

          continue;
        }

        // -------------------------
        // DEFAULT (LinkedIn/FB/IG)
        // -------------------------
        const contentToValidate = (override ?? contentBase).trim();

        // Default platforms only use master mediaIds
        const mediaForPlatform = resolveMedia(dto.mediaIds);

        const result = this.platformRules.validateAndTransform(
          contentToValidate,
          profile.platform as any,
          mediaForPlatform,
          { igKind: dto.contentType as any, FbKind: dto.contentType as any }
        );

        payloads.push({
          socialProfileId: profile.id,
          platform: profile.platform,
          status: 'SCHEDULED',
          contentOverride: result.finalContent,
          metadata: result.threadChain?.length ? { thread: (result.threadChain ?? []).map((c) => ({ content: c })) } : undefined,
        });
      } catch (err: any) {
        errors.push(`[${profile.name}]: ${err?.message ?? 'Validation failed.'}`);
      }
    }

    if (errors.length) {
      throw new BadRequestException(`Validation Failed:\n${errors.join('\n')}`);
    }

    return payloads;
  }

  /**
   * Validate a single X tweet (NO autosplitting).
   * - twitter-text accounts for weighted length
   * - enforce max 4 media items
   */
  private validateSingleTweetOrThrow(content: string, media: MediaItem[]) {
    const text = (content ?? '').trim();
    if (!text) throw new BadRequestException('Tweet cannot be empty.');

    const parsed = twitter.parseTweet(text);
    if (!parsed.valid) throw new BadRequestException('Tweet exceeds X limits (280 weighted chars).');

    if ((media?.length ?? 0) > 4) {
      throw new BadRequestException('X allows max 4 media items per tweet.');
    }
  }

  /**
   * PHASE 2: EXECUTION
   * Call inside prisma.$transaction
   */
  async saveDestinations(
    tx: Prisma.TransactionClient,
    postId: string,
    payloads: any[],
  ) {
    if (!payloads.length) return;

    await tx.postDestination.createMany({
      data: payloads.map((p) => ({
        postId,
        socialProfileId: p.socialProfileId,
        status: p.status,
        contentOverride: p.contentOverride,
        metadata: p.metadata ?? Prisma.JsonNull,
      })),
    });
  }
}
