import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { FacebookService } from '@/social-connection/providers/facebook.service';
import { SocialConnectionService } from '@/social-connection/social-connection.service';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BulkAddProfilesDto } from './dto/bulk-add-profile.dto';
import { Platform } from '@generated/enums';

@Injectable()
export class SocialProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionService: SocialConnectionService,
    private readonly encryption: EncryptionService,
  ) {}

  // social/services/social-profile.service.ts

async addProfilesToWorkspace(workspaceId: string, dto: BulkAddProfilesDto) {
  // 1. CHECK LIMITS (Pre-computation)
  // We need to know if adding X profiles will break the limit
  await this.checkWorkspaceLimits(workspaceId, dto.platformIds.length);

  // 2. FETCH VALID PAGES
  // Get all pages this connection has access to
  const importablePages = await this.connectionService.getImportablePages(dto.connectionId);
  
  const results = {
    success: [],
    errors: []
  };

  // 3. PROCESS EACH ID
  for (const platformId of dto.platformIds) {
    const pageData = importablePages.find(p => p.id === platformId);

    if (!pageData) {
      results.errors.push({ id: platformId, message: 'Page not found in this connection' });
      continue;
    }

    try {
      const profile = await this.prisma.socialProfile.create({
        data: {
          workspaceId,
          socialConnectionId: dto.connectionId,
          platform: pageData.platform as Platform,
          platformId: pageData.id,
          name: pageData.name,
          username: pageData.username,
          picture: pageData.picture,
          accessToken: pageData.accessToken, // The "Key to Post"
          type: this.mapAccountType(pageData.type, pageData.platform),
        },
        select: { id: true, name: true, platform: true }
      });
      
      results.success.push(profile);

    } catch (error) {
      if (error.code === 'P2002') { // Unique constraint violation
        results.errors.push({ id: platformId, message: 'Already added to this workspace' });
      } else {
        results.errors.push({ id: platformId, message: 'Database error' });
      }
    }
  }

  // 4. RETURN REPORT
  // We return partial success so the UI can say "Added 2 accounts, but 1 was already there."
  return {
    message: `Successfully added ${results.success.length} profiles.`,
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
      }
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

  private async checkWorkspaceLimits(workspaceId: string, countToAdd: number) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { 
        organization: { 
          include: { subscription: { include: { plan: true } } } 
        } 
      }
    });

    if (!workspace) throw new NotFoundException('Workspace not found');

    const plan = workspace.organization.subscription?.plan;
    
    // Fallback if no plan found (shouldn't happen with correct onboarding)
    const limit = plan?. maxSocialProfilesPerWorkspace || 3; 


    const currentCount = await this.prisma.socialProfile.count({
      where: { workspaceId }
    });


    if (currentCount + countToAdd > limit) {
      throw new ForbiddenException(
        `Cannot add ${countToAdd} profiles. You have ${limit - currentCount} slots remaining.`
      );
    }
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
