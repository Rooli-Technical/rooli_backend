import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { FacebookService } from '@/social-connection/providers/facebook.service';
import { SocialConnectionService } from '@/social-connection/social-connection.service';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BulkAddProfilesDto } from './dto/request/bulk-add-profile.dto';
import { Platform } from '@generated/enums';

@Injectable()
export class SocialProfileService {
   private readonly logger = new Logger(SocialProfileService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionService: SocialConnectionService,
    private readonly encryption: EncryptionService,
  ) {}

async addProfilesToWorkspace(workspaceId: string, dto: BulkAddProfilesDto) {

 const { remaining, allowedPlatforms } = await this.getWorkspaceLimitInfo(workspaceId);

    // 2. CHECK 1: Is this Platform allowed?
    if (!allowedPlatforms.includes(dto.platform)) {
      throw new ForbiddenException(
        `The ${dto.platform} platform is not available on your current plan. Please upgrade to connect X (Twitter).`
      );
    }

    // 3. CHECK 2: Numeric Limits
    if (dto.platformIds.length > remaining) {
      throw new ForbiddenException(
        `You have ${remaining} slots left, but tried to add ${dto.platformIds.length} profiles.`
      );
    }

  const importablePages = await this.connectionService.getImportablePages(dto.connectionId);
  
  const results = {
    success: [],
    errors: []
  };

  // 2. PROCESS EACH ID
  for (const platformId of dto.platformIds) {
    const pageData = importablePages.find(p => p.id === platformId);

    if (!pageData) {
      results.errors.push({ id: platformId, message: 'Page not found' });
      continue;
    }

    try {
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
        },
      });
      
      results.success.push(profile);

    } catch (error) {
      this.logger.error(error);
      results.errors.push({ id: platformId, message: 'Database error' });
    }
  }

  // 3. RETURN REPORT
  return {
    message: `Processed ${results.success.length} profiles.`,
    added: results.success,
    failures: results.errors
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
            subscription: { include: { plan: true } } 
          } 
        },
        _count: { select: { socialProfiles: true } }
      }
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
      allowedPlatforms: allowed 
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
