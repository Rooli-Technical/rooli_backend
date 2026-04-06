import { PrismaService } from '@/prisma/prisma.service';
import { ConnectionStatus, Platform } from '@generated/enums';
import {
  BadRequestException,
  ForbiddenException,
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
import { TwitterService } from './providers/twitter.service';
import { RedisService } from '@/redis/redis.service';
import { InstagramService } from './providers/instagram.service';
import { TikTokService } from './providers/tiktok.service';

@Injectable()
export class SocialConnectionService {
  private readonly logger = new Logger(SocialConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryptionService: EncryptionService,
    private readonly facebook: FacebookService,
    private readonly linkedin: LinkedInService,
    private readonly twitter: TwitterService,
    private readonly instagram: InstagramService,
    private readonly tiktok: TikTokService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * 1. GET AUTH URL
   * Generates the redirect URL to send the user to (e.g. "facebook.com/dialog/oauth...")
   */
  async getAuthUrl(
    platform: Platform,
    organizationId: string,
  ): Promise<string> {
    // 1. CHECK FEATURE ACCESS
    // Stop them here if their plan doesn't support this platform
    await this.ensurePlatformAllowed(organizationId, platform);

    const rawState = Buffer.from(JSON.stringify({ organizationId })).toString(
      'base64',
    );

    const state = encodeURIComponent(rawState);

    switch (platform) {
      case 'FACEBOOK':
        return this.facebook.generateAuthUrl(state);
      case 'INSTAGRAM':
        return this.instagram.generateAuthUrl(state);
      case 'LINKEDIN':
        return this.linkedin.generateAuthUrl(state);
      case 'TIKTOK':
        return this.tiktok.generateAuthUrl(state);
      case 'TWITTER':
        // Twitter needs to talk to API first to get a token!
        return this.twitter.generateAuthLink(organizationId);
      default:
        throw new BadRequestException(`Platform ${platform} not supported yet`);
    }
  }

  /**
   * 2. HANDLE OAUTH CALLBACK
   * Exchanges code for tokens and creates/updates the SocialConnection.
   * Returns the Connection ID and a list of Pages user can import.
   */
  async handleCallback(platform: Platform, query: any) {
    let authData: OAuthResult;
    let organizationId: string;
    const normalizedPlatform = platform.toUpperCase();

    if (normalizedPlatform === 'TWITTER') {
      const { token, verifier } = query;
      if (!token || !verifier)
        throw new BadRequestException('Missing Twitter tokens');

      // We recover orgId from Redis inside the service or passing logic
      const cached = await this.redisService.get(`twitter_auth:${token}`);
      if (cached) organizationId = JSON.parse(cached).organizationId;

      authData = await this.twitter.login(token, verifier);
    } else {
      const { code, state } = query;

      // Decode State
      let decodedState = decodeURIComponent(state);
      if (decodedState.includes('%'))
        decodedState = decodeURIComponent(decodedState);
      try {
        const jsonString = Buffer.from(decodedState, 'base64').toString(
          'utf-8',
        );
        organizationId = JSON.parse(jsonString).organizationId;
      } catch (e) {
        throw new BadRequestException('Invalid OAuth state');
      }


      // Exchange
      if (normalizedPlatform === 'FACEBOOK')
        authData = await this.facebook.exchangeCode(code);
      else if (normalizedPlatform === 'INSTAGRAM')
        authData = await this.instagram.exchangeCode(code);
      else if (normalizedPlatform === 'LINKEDIN')
        authData = await this.linkedin.exchangeCode(code);
      else if (normalizedPlatform === 'TIKTOK')
        authData = await this.tiktok.exchangeCode(code);
    }

    // 3. UPSERT CONNECTION
    const connection = await this.prisma.socialConnection.upsert({
      where: {
        organizationId_platform_platformUserId: {
          organizationId,
          platform: normalizedPlatform as Platform,
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
        status: ConnectionStatus.CONNECTED,
      },
      create: {
        organizationId,
        platform: normalizedPlatform as Platform,
        platformUserId: authData.providerUserId,
        platformUsername: authData.providerUsername,
        accessToken: await this.encryptionService.encrypt(authData.accessToken),
        refreshToken: authData.refreshToken
          ? await this.encryptionService.encrypt(authData.refreshToken)
          : null,
        tokenExpiresAt: authData.expiresAt,
      },
    });

    // 4. RETURN PAGES
    const availablePages = await this.getImportablePages(connection.id);
    return {
      message: 'Connection successful',
      connectionId: connection.id,
      availablePages,
    };
  }

  /**
   * 3. GET IMPORTABLE PAGES
   */
  async getImportablePages(
    connectionId: string,
    includeTokens = false,
  ): Promise<SocialPageOption[]> {
    const connection = await this.prisma.socialConnection.findUnique({
      where: { id: connectionId, status: ConnectionStatus.CONNECTED },
    });
    if (!connection) throw new NotFoundException('Connection not found');

    const accessToken = await this.encryptionService.decrypt(
      connection.accessToken,
    );

    let pages;

    try {
      switch (connection.platform) {
        case 'FACEBOOK':
          pages = await this.facebook.getPages(accessToken);
          break;
        case 'INSTAGRAM':
          pages = (await this.instagram.getAccount(
            accessToken,
          )) as SocialPageOption[];
          break;
        case 'LINKEDIN':
          pages = await this.linkedin.getImportablePages(accessToken);
          break;
        case 'TIKTOK':
          pages = await this.tiktok.getAccount(accessToken);
          break;
        case 'TWITTER':
          const accessSecret = connection.refreshToken
            ? await this.encryptionService.decrypt(connection.refreshToken)
            : '';
          pages = await this.twitter.getProfile(accessToken, accessSecret);
          break;
        default:
          pages = [];
      }
      if (includeTokens) {
        return pages; // Return everything including tokens
      }
      return pages.map(({ accessToken, refreshToken, ...safe }) => safe);
    } catch (error: any) {
      this.logger.warn(`Failed to fetch pages: ${error.message}`);
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
      where: {
        id: connectionId,
        organizationId,
        status: ConnectionStatus.CONNECTED,
      },
      include: { profiles: true },
    });

    if (!connection) throw new NotFoundException('Social Connection not found');

    const token = await this.encryptionService.decrypt(connection.accessToken);

    switch (connection.platform) {
      case 'FACEBOOK':
        await this.facebook.disconnect(token);
        break;

      case 'INSTAGRAM':
        const isNativeIg = token.trim().startsWith('IG');

        if (isNativeIg) {
          await this.instagram.disconnect(token);
        } else {
          this.logger.log(
            `Skipping token revocation for FB-connected IG connection to protect parent Facebook login.`,
          );
        }
        break;
      case 'TIKTOK':
        await this.tiktok.disconnect(token);
        break;

      default:
        this.logger.warn(
          `No revocation logic defined for platform: ${connection.platform}`,
        );
    }

    // 4. Soft Delete the connection from the database
    await this.prisma.socialConnection.update({
      where: { id: connectionId },
      data: {
        status: ConnectionStatus.DISCONNECTED,
        // Cascade the disconnect to all linked profiles automatically
        profiles: {
          updateMany: {
            where: { socialConnectionId: connectionId },
            data: { status: ConnectionStatus.DISCONNECTED },
          },
        },
      },
    });

    return {
      message: 'Connection disconnected and associated profiles paused.',
    };
  }

  private async ensurePlatformAllowed(orgId: string, platform: Platform) {
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId: orgId, status: 'active' },
      include: { plan: true },
    });

    // If no active sub, maybe allow free tier logic or throw
    if (!sub) throw new ForbiddenException('No active subscription found.');

    const allowed = sub.plan.allowedPlatforms;

    if (!allowed.includes(platform)) {
      throw new ForbiddenException(
        `Your current plan (${sub.plan.name}) does not support ${platform}. Please upgrade.`,
      );
    }
  }

  async subscribePage(
    connectionId: string,
    pageId: string,
    pageAccessToken: string,
  ) {
    const connection = await this.prisma.socialConnection.findUnique({
      where: { id: connectionId, status: ConnectionStatus.CONNECTED },
    });

    if (!connection) {
      throw new BadRequestException('Invalid Facebook connection');
    }
    // 2. Routing Logic
    try {
      switch (connection.platform) {
        case 'FACEBOOK':
          // Facebook just needs the ID and Token
          return await this.facebook.subscribeAppToPage(
            pageId,
            pageAccessToken,
          );

        case 'LINKEDIN':
          if (!pageId.startsWith('urn:li:organization:')) {
            this.logger.debug(
              `Skipping webhook sub for personal profile: ${pageId}`,
            );
            return false; // Skip safely without throwing an error
          }

          const userUrn = connection.platformUserId;
          return await this.linkedin.subscribeOrganizationToWebhook(
            userUrn,
            pageId, // This is your organizationUrn
            pageAccessToken,
          );
        case 'TWITTER':
          if (!connection.refreshToken) {
            throw new BadRequestException('Missing Twitter access secret');
          }
          const accessSecret = await this.encryptionService.decrypt(
            connection.refreshToken,
          );
          return await this.twitter.subscribeToWebhooks(
            pageAccessToken,
            accessSecret,
          );

        default:
          throw new BadRequestException(
            `Platform ${connection.platform} not supported for webhooks`,
          );
      }
    } catch (error: any) {
      this.logger.error(
        `Subscription failed for ${connection.platform}: ${error.message}`,
      );
      throw error;
    }
  }

  async subscribeByConnectionId(connectionId: string): Promise<boolean> {
    // 1. Fetch the specific LinkedIn connection
    const connection = await this.prisma.socialConnection.findUnique({
      where: { id: connectionId, status: ConnectionStatus.CONNECTED },
    });

    // 2. Validation
    if (!connection || connection.platform !== 'LINKEDIN') {
      throw new BadRequestException('Valid LinkedIn connection required');
    }

    if (!connection.accessToken) {
      throw new BadRequestException(
        'Missing access token for LinkedIn connection',
      );
    }

    const token = await this.encryptionService.decrypt(connection.accessToken);

    // 3. Extract necessary URNs
    // pageId is usually stored in the 'externalId' or 'platformPageId' column
    const organizationUrn = 'urn:li:organization:109376565';
    const userUrn = 'urn:li:person:oaxV-EunJg';

    if (!organizationUrn || !userUrn) {
      throw new BadRequestException(
        'Connection missing required URNs (User or Organization)',
      );
    }

    // 4. Safety Check
    if (!organizationUrn.startsWith('urn:li:organization:')) {
      this.logger.warn(
        `Attempted to subscribe a non-organization URN: ${organizationUrn}`,
      );
      return false;
    }

    this.logger.log(
      `Initiating LinkedIn subscription for Org: ${organizationUrn}`,
    );

    // 5. Delegate to your provider
    return await this.linkedin.subscribeOrganizationToWebhook(
      userUrn,
      organizationUrn,
      token,
    );
  }
}
