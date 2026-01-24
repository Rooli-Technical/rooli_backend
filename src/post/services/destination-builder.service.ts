import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@generated/client';
import { Injectable, BadRequestException } from '@nestjs/common';
import { PlatformRulesService } from './platform-rules.service';
import { CreatePostDto } from '../dto/request/create-post.dto';

@Injectable()
export class DestinationBuilder {
  constructor(
    private platformRules: PlatformRulesService,
    private prisma: PrismaService,
  ) {}

  async validateProfiles(workspaceId: string, ids: string[]) {
    const profiles = await this.prisma.socialProfile.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true, platform: true },
    });

    if (profiles.length !== ids.length) {
      throw new BadRequestException(
        'One or more selected profiles do not belong to this workspace.',
      );
    }

    return profiles;
  }

  buildOverrideMap(overrides: any[]) {
    const map = new Map<string, string>();
    overrides?.forEach((o) => map.set(o.socialProfileId, o.content));
    return map;
  }

  /**
   * PHASE 1: PREPARATION
   * call this BEFORE prisma.$transaction
   */
  async preparePayloads(
    workspaceId: string,
    dto: CreatePostDto,
  ): Promise<any[]> {
    // 1. Fetch Profiles (Added 'name' to select for error messages)
    const profiles = await this.prisma.socialProfile.findMany({
      where: { id: { in: dto.socialProfileIds }, workspaceId },
      select: { id: true, platform: true, name: true },
    });

    if (profiles.length !== dto.socialProfileIds.length) {
      throw new BadRequestException(
        'One or more profiles do not belong to this workspace.',
      );
    }

    // 2. Build Overrides Map
    const overrideMap = new Map<string, string>();
    dto.overrides?.forEach((o) =>
      overrideMap.set(o.socialProfileId, o.content),
    );

    // 3. Prepare Media (Simplification: assuming global media for now)
    // In a real app, you might query DB to get media dimensions here.
      // 3. Fetch Media Metadata
    let mediaItems: any[] = [];
    if (dto.mediaIds?.length) {
      // We only need dimensions, not the whole blob
      mediaItems = await this.prisma.mediaFile.findMany({
        where: { id: { in: dto.mediaIds } },
        select: { url: true, width: true, height: true, mimeType: true },
      });
    }

    const payloads = [];
    const errors: string[] = [];

    // 4. Logic & Transformation Loop
    for (const profile of profiles) {
      const contentToValidate = overrideMap.get(profile.id) || dto.content;

      try {
        // Transform (Auto-split Twitter, validate limits)
        const result = this.platformRules.validateAndTransform(
          contentToValidate,
          profile.platform as any, // Cast to your Enum
          mediaItems,
        );

        payloads.push({
          socialProfileId: profile.id,
          status: 'SCHEDULED', // Or pass status in if needed
          platform: profile.platform,
          contentOverride: result.finalContent, // The Main Post
          metadata: result.threadChain?.length
            ? { threadChain: result.threadChain } // The Thread Parts
            : undefined,
        });
      } catch (error) {
        // Collect errors instead of failing on the first one
        errors.push(`[${profile.name}]: ${error.message}`);
      }
    }

    // Fail if ANY profile is invalid
    if (errors.length > 0) {
      throw new BadRequestException(`Validation Failed:\n${errors.join('\n')}`);
    }

    return payloads;
  }

  /**
   * PHASE 2: EXECUTION
   * Call this INSIDE prisma.$transaction
   */
  async saveDestinations(
    tx: Prisma.TransactionClient,
    postId: string,
    payloads: any[],
  ) {
    if (!payloads.length) return;

    // Fast, batch insert. No logic here.
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
