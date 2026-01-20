import { PrismaService } from '@/prisma/prisma.service';
import { Platform } from '@generated/enums';
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

    if (platform === 'TWITTER') {
      const { token, verifier } = query;
      if (!token || !verifier)
        throw new BadRequestException('Missing Twitter tokens');

      // We recover orgId from Redis inside the service or passing logic
      const cached = await this.redisService.get(`twitter_auth:${token}`);
      if (cached) organizationId = JSON.parse(cached).organizationId;

      authData = await this.twitter.login(token, verifier);
      console.log(authData)
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
      if (platform === 'FACEBOOK')
        authData = await this.facebook.exchangeCode(code);
      else if (platform === 'INSTAGRAM')
        authData = await this.instagram.exchangeCode(code);
      else if (platform === 'LINKEDIN')
        authData = await this.linkedin.exchangeCode(code);
    }

    // 3. UPSERT CONNECTION
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
  async getImportablePages(connectionId: string): Promise<SocialPageOption[]> {
    const connection = await this.prisma.socialConnection.findUnique({
      where: { id: connectionId },
    });
    if (!connection) throw new NotFoundException('Connection not found');

    const accessToken = await this.encryptionService.decrypt(
      connection.accessToken,
    );

    try {
      switch (connection.platform) {
        case 'FACEBOOK':
          return await this.facebook.getPages(accessToken);
        case 'INSTAGRAM':
          return (await this.instagram.getAccount(
            accessToken,
          )) as SocialPageOption[];
        case 'LINKEDIN':
          return await this.linkedin.getImportablePages(accessToken);
        case 'TWITTER':
          const accessSecret = connection.refreshToken
            ? await this.encryptionService.decrypt(connection.refreshToken)
            : '';
          return await this.twitter.getProfile(accessToken, accessSecret);

        default:
          return [];
      }
    } catch (error) {
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
}
