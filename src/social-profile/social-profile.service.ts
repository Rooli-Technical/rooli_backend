import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
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
import { ConnectionStatus, Platform } from '@generated/enums';
import { DomainEventsService } from '@/events/domain-events.service';
import { PlanAccessService } from '@/plan-access/plan-access.service';

@Injectable()
export class SocialProfileService {
  private readonly logger = new Logger(SocialProfileService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionService: SocialConnectionService,
    private readonly encryption: EncryptionService,
    private readonly domainEvents: DomainEventsService,
    private readonly planAccessService: PlanAccessService,
  ) {}

  async addProfilesToWorkspace(workspaceId: string, dto: BulkAddProfilesDto) {
    // 1. Get the Workspace to find the Organization ID
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const orgId = workspace.organizationId;

    // 2. ENFORCE BILLING & PLAN PLATFORM ACCESS
    await this.planAccessService.ensurePlatformAllowed(orgId, dto.platform);

    // 3. Slot calculation (count ONLY new profiles)
    const existingInWorkspace = await this.prisma.socialProfile.findMany({
      where: { workspaceId, platformId: { in: dto.platformIds } },
      select: { platformId: true },
    });

    const existingIds = new Set(existingInWorkspace.map((p) => p.platformId));
    const newProfilesCount = dto.platformIds.filter(
      (id) => !existingIds.has(id),
    ).length;

    // 4. ENFORCE BILLING PROFILE LIMITS
    if (newProfilesCount > 0) {
      await this.planAccessService.ensureSocialProfileLimit(
        orgId,
        newProfilesCount,
      );
    }

    // 5. Fetch importable pages once
    const importablePages = await this.connectionService.getImportablePages(
      dto.connectionId,
      true,
    );

    const added: any[] = [];

    // 4. Deterministic, sequential processing
    for (const platformId of dto.platformIds) {
      const pageData = importablePages.find((p) => p.id === platformId);

      if (!pageData) {
        throw new NotFoundException(
          `Page ${platformId} not found in connected account`,
        );
      }

      // 5. Global ownership check (authoritative)
      const activeGlobalProfile = await this.prisma.socialProfile.findFirst({
        where: {
          platform: pageData.platform as Platform,
          platformId: pageData.id,
          status: ConnectionStatus.CONNECTED, // Only block if another workspace has it actively CONNECTED
        },
        select: { id: true, workspaceId: true },
      });

      // If we found an active profile, and it does NOT belong to the current workspace, reject it.
      if (
        activeGlobalProfile &&
        activeGlobalProfile.workspaceId !== workspaceId
      ) {
        throw new ConflictException(
          'This page is already actively connected to another workspace. ' +
            'Only one workspace can own a page inbox at a time.',
        );
      }

      // 6. Upsert using GLOBAL identity key
      const profile = await this.prisma.socialProfile.upsert({
        where: {
          workspaceId_platform_platformId: {
            workspaceId,
            platform: pageData.platform as Platform,
            platformId: pageData.id,
          },
        },
        update: {
          socialConnectionId: dto.connectionId,
          name: pageData.name,
          username: pageData.username,
          picture: pageData.picture,
          accessToken: await this.encryption.encrypt(pageData.accessToken),
          facebookPageId: pageData.facebookPageId || null,
          status: ConnectionStatus.CONNECTED,
          webhookRoutingUserId: pageData.user_id,
        },
        create: {
          workspaceId,
          socialConnectionId: dto.connectionId,
          platform: pageData.platform as Platform,
          platformId: pageData.id,
          name: pageData.name,
          username: pageData.username,
          picture: pageData.picture,
          accessToken: await this.encryption.encrypt(pageData.accessToken),
          type: this.mapAccountType(pageData.type, pageData.platform),
          facebookPageId: pageData.facebookPageId || null,
          status: ConnectionStatus.CONNECTED,
          webhookRoutingUserId: pageData.user_id,
        },
      });

      // 7. External side-effect AFTER DB identity exists
      if (
        pageData.platform === 'FACEBOOK' ||
        pageData.platform === 'LINKEDIN'
      ) {
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
      where: { workspaceId, status: ConnectionStatus.CONNECTED },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        picture: true,
        platform: true,
        type: true,
        username: true,
        isActive: true,
        status: true,
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
   * Soft disconnects the profile from the workspace.
   */
  async removeProfile(workspaceId: string, profileId: string) {
    const profile = await this.prisma.socialProfile.findFirst({
      where: { id: profileId, workspaceId },
      include: { workspace: { select: { organizationId: true } } },
    });

    if (!profile) throw new NotFoundException('Profile not found');


    await this.prisma.socialProfile.update({
      where: { id: profileId },
      data: {
        status: ConnectionStatus.DISCONNECTED,
      },
    });

    return {
      message: 'Account disconnected from workspace. History preserved.',
    };
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private mapAccountType(providerType: string, platform: string): any {
    // Simple mapper to convert string 'PAGE' to Enum 'FACEBOOK_PAGE'
    if (platform === 'FACEBOOK') return 'FACEBOOK_PAGE';
    if (platform === 'INSTAGRAM') return 'INSTAGRAM_BUSINESS';
    if (platform === 'LINKEDIN') {
      return providerType === 'PAGE' ? 'LINKEDIN_PAGE' : 'LINKEDIN_PROFILE';
    }
    if (platform === 'TWITTER') return 'TWITTER_PROFILE';
    if (platform === 'TIKTOK') return 'TIKTOK_BUSINESS';

    return 'FACEBOOK_PAGE'; // Default safety
  }
}
