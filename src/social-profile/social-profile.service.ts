import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { FacebookService } from '@/social-connection/providers/facebook.service';
import { SocialConnectionService } from '@/social-connection/social-connection.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BulkAddProfilesDto } from './dto/request/bulk-add-profile.dto';
import { Platform } from '@generated/enums';
import { DomainEventsService } from '@/events/domain-events.service';

@Injectable()
export class SocialProfileService {
  private readonly logger = new Logger(SocialProfileService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionService: SocialConnectionService,
    private readonly encryption: EncryptionService,
    private readonly domainEvents: DomainEventsService,
  ) {}

async addProfilesToWorkspace(
  workspaceId: string,
  dto: BulkAddProfilesDto,
) {
  const { remaining, allowedPlatforms } =
    await this.getWorkspaceLimitInfo(workspaceId);

  // // 1. Plan guard
  if (!allowedPlatforms.includes(dto.platform)) {
    throw new ForbiddenException(
      `The ${dto.platform} platform is not available on your current plan.`,
    );
  }

  // 2. Fetch importable pages once
  const importablePages =
    await this.connectionService.getImportablePages(
      dto.connectionId,
      true,
    );

  // 3. Slot calculation (count ONLY new profiles)
  const existingInWorkspace =
    await this.prisma.socialProfile.findMany({
      where: {
        workspaceId,
        platformId: { in: dto.platformIds },
      },
      select: { platformId: true },
    });

  const existingIds = new Set(
    existingInWorkspace.map(p => p.platformId),
  );


  const newProfilesCount = dto.platformIds.filter(
    id => !existingIds.has(id),
  ).length;


  if (newProfilesCount > remaining) {
    throw new ForbiddenException(
      `You have ${remaining} slots left, but tried to add ${newProfilesCount} new profiles.`,
    );
  }

  const added: any[] = [];

  // 4. Deterministic, sequential processing
  for (const platformId of dto.platformIds) {
    const pageData = importablePages.find(p => p.id === platformId);

    if (!pageData) {
      throw new NotFoundException(
        `Page ${platformId} not found in connected account`,
      );
    }

    // 5. Global ownership check (authoritative)
    const existingGlobal =
      await this.prisma.socialProfile.findUnique({
        where: {
          platform_platformId: {
            platform: pageData.platform as Platform,
            platformId: pageData.id,
          },
        },
        select: { id: true, workspaceId: true },
      });

    if (
      existingGlobal &&
      existingGlobal.workspaceId !== workspaceId
    ) {
      throw new ConflictException(
        'This page is already connected to another workspace. ' +
        'Only one workspace can own a page inbox at a time.',
      );
    }

    // 6. Upsert using GLOBAL identity key
    const profile =
      await this.prisma.socialProfile.upsert({
        where: {
          platform_platformId: {
            platform: pageData.platform as Platform,
            platformId: pageData.id,
          },
        },
        update: {
          socialConnectionId: dto.connectionId,
          name: pageData.name,
          username: pageData.username,
          picture: pageData.picture,
          accessToken: await this.encryption.encrypt(
            pageData.accessToken,
          ),
          facebookPageId: pageData.facebookPageId || null,
        },
        create: {
          workspaceId,
          socialConnectionId: dto.connectionId,
          platform: pageData.platform as Platform,
          platformId: pageData.id,
          name: pageData.name,
          username: pageData.username,
          picture: pageData.picture,
          accessToken: await this.encryption.encrypt(
            pageData.accessToken,
          ),
          type: this.mapAccountType(
            pageData.type,
            pageData.platform,
          ),
          facebookPageId: pageData.facebookPageId || null,
        },
      });

    // 7. External side-effect AFTER DB identity exists
    if (pageData.platform === 'FACEBOOK' || pageData.platform === 'LINKEDIN') {
      try {
         await this.connectionService.subscribePage(
            dto.connectionId,
            pageData.id,
            pageData.accessToken,
          );
      } catch (err) {
        throw err;
      }
    }

    added.push(profile);

    this.domainEvents.emit('system.social_profile.connected', {
      workspaceId,
      profileId: profile.id,
      platform: profile.platform,
    });
  }

  return {
    message: `Added ${added.length} profile(s).`,
    added,
  };
}
  /**
   * 2. LIST WORKSPACE PROFILES
   * Used for the Sidebar or "Accounts" page.
   */
  async getWorkspaceProfiles(workspaceId: string) {
    return this.prisma.socialProfile.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        picture: true,
        platform: true,
        type: true,
        username: true,
        isActive: true,
        followerCount: true,
        connection: {
          select: {
            id: true,
          },
        },
      },
    });
  }
  /**
   * 3. REMOVE PROFILE
   * Only removes it from the workspace. Does NOT delete the parent connection.
   */
  async removeProfile(workspaceId: string, profileId: string) {
    const profile = await this.prisma.socialProfile.findFirst({
      where: { id: profileId, workspaceId },
    });

    if (!profile) throw new NotFoundException('Profile not found');

    await this.prisma.socialProfile.delete({
      where: { id: profileId },
    });

    return { message: 'Account removed from workspace' };
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private async getWorkspaceLimitInfo(workspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        organization: {
          include: {
            subscription: { include: { plan: true } },
          },
        },
        _count: { select: { socialProfiles: true } },
      },
    });

    if (!workspace) throw new NotFoundException('Workspace not found');

    const plan = workspace.organization.subscription?.plan;

    const limit = plan?.maxSocialProfilesPerWorkspace;
    const allowed = plan?.allowedPlatforms || [];

    const current = workspace._count.socialProfiles;

    return {
      limit,
      current,
      remaining: limit === -1 ? 9999 : Math.max(0, limit - current),
      allowedPlatforms: allowed,
    };
  }

  private mapAccountType(providerType: string, platform: string): any {
    // Simple mapper to convert string 'PAGE' to Enum 'FACEBOOK_PAGE'
    if (platform === 'FACEBOOK') return 'FACEBOOK_PAGE';
    if (platform === 'INSTAGRAM') return 'INSTAGRAM_BUSINESS';
    if (platform === 'LINKEDIN') {
      return providerType === 'PAGE' ? 'LINKEDIN_PAGE' : 'LINKEDIN_PROFILE';
    }
    if (platform === 'TWITTER') return 'TWITTER_PROFILE';

    return 'FACEBOOK_PAGE'; // Default safety
  }
}
