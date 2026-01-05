import { PrismaService } from '@/prisma/prisma.service';
import { Platform } from '@generated/enums';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OAuthResult,
  SocialPageOption,
} from './interfaces/social-provider.interface';
import { FacebookService } from './providers/facebook.service';
import { EncryptionService } from '@/common/utility/encryption.service';
import { LinkedInService } from './providers/linkedin.service';

@Injectable()
export class SocialConnectionService {
  private readonly logger = new Logger(SocialConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryptionService: EncryptionService,
    private readonly facebook: FacebookService,
    private readonly linkedin: LinkedInService,
    // private readonly twitter: TwitterService,
  ) {}

  /**
   * 1. GET AUTH URL
   * Generates the redirect URL to send the user to (e.g. "facebook.com/dialog/oauth...")
   */
  getAuthUrl(platform: Platform, organizationId: string): string {
    const rawState = Buffer.from(JSON.stringify({ organizationId })).toString(
      'base64',
    );

    const state = encodeURIComponent(rawState);

    switch (platform) {
      case 'FACEBOOK':
        return this.facebook.generateAuthUrl(state);
      case 'LINKEDIN':
        return this.linkedin.generateAuthUrl(state);
      // case 'TWITTER': return this.twitter.generateAuthUrl(state);
      default:
        throw new BadRequestException(`Platform ${platform} not supported yet`);
    }
  }

  /**
   * 2. HANDLE OAUTH CALLBACK
   * Exchanges code for tokens and creates/updates the SocialConnection.
   * Returns the Connection ID and a list of Pages user can import.
   */
  async handleCallback(platform: Platform, code: string, state: string) {
    let decodedState = decodeURIComponent(state);
    //  If the string still contains encoded characters (like %3D), decode again.
    if (decodedState.includes('%')) {
      decodedState = decodeURIComponent(decodedState);
    }

    let organizationId: string;
    try {
      const jsonString = Buffer.from(decodedState, 'base64').toString('utf-8');
      const decoded = JSON.parse(jsonString);
      organizationId = decoded.organizationId;
    } catch (e) {
      this.logger.error(`State Decode Failed. Input: ${state}`);
      throw new BadRequestException('Invalid OAuth state');
    }
    // 2. Exchange Code for Tokens (Platform Specific)
    let authData: OAuthResult;
    try {
      switch (platform) {
        case 'FACEBOOK':
          authData = await this.facebook.exchangeCode(code);
          break;
        case 'LINKEDIN':
          authData = await this.linkedin.exchangeCode(code);
          break;
        default:
          throw new BadRequestException('Platform not implemented');
      }
    } catch (error) {
      this.logger.error(`OAuth Exchange Failed: ${error.message}`);
      throw new BadRequestException('Failed to connect with social provider');
    }

    // 3. Upsert SocialConnection (The "Master Key")
    // We maintain ONE connection per Platform per User per Org.
    const connection = await this.prisma.socialConnection.upsert({
      where: {
        organizationId_platform_platformUserId: {
          organizationId,
          platform,
          platformUserId: authData.providerUserId,
        },
      },
      update: {
        accessToken: await this.encryptionService.encrypt(authData.accessToken),
        refreshToken: authData.refreshToken
          ? await this.encryptionService.encrypt(authData.refreshToken)
          : null,
        tokenExpiresAt: authData.expiresAt,
        updatedAt: new Date(),
      },
      create: {
        organizationId,
        platform,
        platformUserId: authData.providerUserId,
        platformUsername: authData.providerUsername,
        accessToken: await this.encryptionService.encrypt(authData.accessToken),
        refreshToken: authData.refreshToken
          ? await this.encryptionService.encrypt(authData.refreshToken)
          : null,
        tokenExpiresAt: authData.expiresAt,
      },
    });

    // 4. Fetch Available Pages (Immediate Gratification)
    // We want to show the user "Here is what you can connect" immediately.
    const availablePages = await this.getImportablePages(connection.id);

    return {
      message: 'Connection successful',
      connectionId: connection.id,
      availablePages, // Frontend displays these in a selection modal
    };
  }

  /**
   * 3. GET IMPORTABLE PAGES
   * Uses the stored "Master Key" to ask the provider for a list of pages.
   */
  async getImportablePages(connectionId: string): Promise<SocialPageOption[]> {
    const connection = await this.prisma.socialConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) throw new NotFoundException('Connection not found');

    const decryptedToken = await this.encryptionService.decrypt(
      connection.accessToken,
    );

    try {
      switch (connection.platform) {
        case 'FACEBOOK':
          // Returns Facebook Pages AND Instagram Business Accounts
          return await this.facebook.getPages(decryptedToken);

        case 'LINKEDIN':
          // Returns LinkedIn Company Pages
          return await this.linkedin.getImportablePages(decryptedToken);

        // case 'TWITTER':
        //   // Twitter is usually just the profile itself
        //   return [
        //     {
        //       id: connection.platformUserId,
        //       name: connection.platformUsername || 'Twitter Profile',
        //       platform: 'TWITTER',
        //       type: 'PROFILE',
        //       accessToken: connection.accessToken, // User token is the posting token
        //     },
        //   ];

        default:
          return [];
      }
    } catch (error) {
      // If token is invalid, we might need to flag the connection as expired here
      this.logger.warn(
        `Failed to fetch pages for ${connectionId}: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * 4. DISCONNECT
   * Revokes tokens (optional) and deletes the connection.
   * Cascade deletes all linked SocialProfiles in Workspaces.
   */
  async disconnect(connectionId: string, organizationId: string) {
    const connection = await this.prisma.socialConnection.findFirst({
      where: { id: connectionId, organizationId },
    });

    if (!connection) throw new NotFoundException('Connection not found');

    // Optional: Call provider API to revoke token (Clean exit)
    // await this.facebook.revokeToken(connection.accessToken);

    await this.prisma.socialConnection.delete({
      where: { id: connectionId },
    });

    return { message: 'Connection removed and associated profiles unlinked.' };
  }
}
