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
import { PlanAccessService } from '@/plan-access/plan-access.service';
import { MailService } from '@/mail/mail.service';

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
    private readonly planAccessService: PlanAccessService,
    private readonly emailService: MailService,
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
    await this.planAccessService.ensurePlatformAllowed(
      organizationId,
      platform,
    );

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

    if (platform === 'TWITTER') {
      const { token, verifier } = query;
      if (!token || !verifier)
        throw new BadRequestException('Missing Twitter tokens');

      // We recover orgId from Redis inside the service or passing logic
      const cached = await this.redisService.get(`twitter_auth:${token}`);
      if (cached) organizationId = JSON.parse(cached).organizationId;

      if (!cached) {
        throw new BadRequestException(
          'Twitter authentication session expired. Please try again.',
        );
      }

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

      // Check billing status right before we upsert the connection
      await this.planAccessService.ensureActiveBilling(organizationId);

      // Exchange
      if (platform === 'FACEBOOK')
        authData = await this.facebook.exchangeCode(code);
      else if (platform === 'INSTAGRAM')
        authData = await this.instagram.exchangeCode(code);
      else if (platform === 'LINKEDIN')
        authData = await this.linkedin.exchangeCode(code);
      else if (platform === 'TIKTOK')
        authData = await this.tiktok.exchangeCode(code);
    }

    // 3. UPSERT CONNECTION
    const connection = await this.prisma.socialConnection.upsert({
      where: {
        organizationId_platform_platformUserId: {
          organizationId,
          platform: platform,
          platformUserId: authData.providerUserId,
        },
      },
      update: {
        accessToken: await this.encryptionService.encrypt(authData.accessToken),
        refreshToken: authData.refreshToken
          ? await this.encryptionService.encrypt(authData.refreshToken)
          : null,
        tokenExpiresAt: authData.expiresAt,
        refreshExpiresAt: authData.refreshExpiresAt,
        reconnectWarningSentAt: null,
        updatedAt: new Date(),
        status: ConnectionStatus.CONNECTED,
      },
      create: {
        organizationId,
        platform: platform,
        platformUserId: authData.providerUserId,
        platformUsername: authData.providerUsername,
        accessToken: await this.encryptionService.encrypt(authData.accessToken),
        refreshToken: authData.refreshToken
          ? await this.encryptionService.encrypt(authData.refreshToken)
          : null,
        tokenExpiresAt: authData.expiresAt,
        refreshExpiresAt: authData.refreshExpiresAt,
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
    const userUrn = connection.platformUserId;

    if (!userUrn) {
      throw new BadRequestException(
        'Connection missing required URNs (User or Organization)',
      );
    }

    // 4. Safety Check
    if (!userUrn.startsWith('urn:li:person:')) {
      this.logger.warn(
        `Attempted to subscribe a non-organization URN: ${userUrn}`,
      );
      return false;
    }

    this.logger.log(`Initiating LinkedIn subscription for Org: ${userUrn}`);

    // 5. Delegate to your provider
    return await this.linkedin.subscribeOrganizationToWebhook(
      userUrn,
      userUrn,
      token,
    );
  }

  // ---------------------------------------------------------
  // 5. THE TOKEN REFRESH SWEEPER (Cron Job)
  // ---------------------------------------------------------
  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async refreshExpiringTokens() {
    this.logger.log('🧹 Sweeping for expiring Social OAuth tokens...');

    const now = new Date();
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(now.getDate() + 3);

    // 1. Find all active connections where the token is about to expire
    const expiringConnections = await this.prisma.socialConnection.findMany({
      where: {
        status: 'CONNECTED',
        tokenExpiresAt: {
          lte: threeDaysFromNow,
          gt: now,
        },
        refreshToken: { not: null },
      },
    });

    if (expiringConnections.length === 0) {
      this.logger.log('✅ No tokens require refreshing today.');
      return;
    }

    let successCount = 0;
    
    // 🚨 Array to hold the failures for our bulk emailer!
    const failedConnectionsToNotify: any[] = [];

    // 2. Loop through and refresh them
    for (const connection of expiringConnections) {
      try {
        const rawRefreshToken = await this.encryptionService.decrypt(
          connection.refreshToken! // We know it's not null from the query
        );

        let newTokens: { accessToken: string; refreshToken?: string; expiresAt: Date, refreshExpiresAt?: Date };

        // Call the provider
        switch (connection.platform) {
          case 'LINKEDIN':
            newTokens = await this.linkedin.refreshToken(rawRefreshToken);
            break;
          case 'TIKTOK':
            newTokens = await this.tiktok.refreshToken(rawRefreshToken);
            break;
          case 'INSTAGRAM':
            const currentAccessToken = await this.encryptionService.decrypt(connection.accessToken);
            newTokens = await this.instagram.refreshToken(currentAccessToken);
            break;
          default:
            continue; 
        }

        // Encrypt the new values
        const encryptedAccessToken = await this.encryptionService.encrypt(newTokens.accessToken);
        const encryptedRefreshToken = newTokens.refreshToken 
          ? await this.encryptionService.encrypt(newTokens.refreshToken) 
          : connection.refreshToken;

        // UPDATE BOTH TABLES SIMULTANEOUSLY
        // We use a Prisma Transaction to ensure both tables stay perfectly in sync
        await this.prisma.$transaction([
          // A. Update the parent Connection
          this.prisma.socialConnection.update({
            where: { id: connection.id },
            data: {
              accessToken: encryptedAccessToken,
              refreshToken: encryptedRefreshToken,
              tokenExpiresAt: newTokens.expiresAt,
              refreshExpiresAt: newTokens.refreshExpiresAt || connection.refreshExpiresAt,
              updatedAt: new Date(),
            },
          }),
          // B. Cascade the fresh token to ALL Workspaces using this profile!
          this.prisma.socialProfile.updateMany({
            where: { socialConnectionId: connection.id },
            data: {
              accessToken: encryptedAccessToken,
              updatedAt: new Date(),
            }
          })
        ]);

        successCount++;

      } catch (error) {
        this.logger.error(`Token refresh failed for Connection: ${connection.id}`, error);
        
        // REACTIVE HANDLING: The token is permanently dead.
        // Sever the connection in BOTH tables
        await this.prisma.$transaction([
          this.prisma.socialConnection.update({
            where: { id: connection.id },
            data: { status: 'DISCONNECTED' },
          }),
          this.prisma.socialProfile.updateMany({
            where: { socialConnectionId: connection.id },
            data: { status: 'DISCONNECTED' },
          })
        ]);

        // Push to the array instead of sending the email instantly
        failedConnectionsToNotify.push(connection);
      }
    }

    this.logger.log(`🔄 Token Refresh Complete. Success: ${successCount}. Failures: ${failedConnectionsToNotify.length}`);

    // 3. Fire off the bulk emails AFTER the loop has safely finished all DB work
    if (failedConnectionsToNotify.length > 0) {
      this.logger.log(`Processing ${failedConnectionsToNotify.length} failure notifications...`);
      await this.sendBulkFailureNotifications(failedConnectionsToNotify);
    }
  }
  // ---------------------------------------------------------
  // 6. THE RECONNECT WARNING SWEEPER (Cron Job)
  // ---------------------------------------------------------
  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async warnExpiringRefreshTokens() {
    this.logger.log('🕵️ Checking for Refresh Tokens nearing their 1-year death date...');

    const now = new Date();
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(now.getDate() + 7);

    // 1. Find connections dying in the next 7 days that WE HAVEN'T WARNED YET
    const expiringConnections = await this.prisma.socialConnection.findMany({
      where: {
        status: 'CONNECTED',
        refreshExpiresAt: {
          lte: sevenDaysFromNow, // Less than 7 days left
          gt: now,               // But not completely dead yet
        },
        reconnectWarningSentAt: null, // 👈 Crucial! Only fetch ones we haven't emailed about
      },
      include: {
        organization: {
          include: {
            members: {
              where: { role: { slug: 'org-owner' } }, // Get the Org Owner
              include: { user: true },
              take: 1,
            },
          },
        },
      },
    });

    if (expiringConnections.length === 0) return;

    // 2. Loop through and alert the owners
    for (const connection of expiringConnections) {
      const owner = connection.organization?.members[0]?.user;
      
      if (owner) {
        try {
          // Send the Email
          await this.emailService.sendReconnectWarningEmail(
            owner.email,
            owner.firstName,
            connection.platform, // e.g., "TikTok"
            connection.platformUsername, // e.g., "@rooli_agency"
          );

          // Mark it as sent so they don't get 7 emails in a row!
          await this.prisma.socialConnection.update({
            where: { id: connection.id },
            data: { reconnectWarningSentAt: new Date() },
          });

          this.logger.log(`Warning email sent to ${owner.email} for ${connection.platform}`);
        } catch (error) {
          this.logger.error(`Failed to send reconnect warning for Connection ${connection.id}`, error);
        }
      }
    }
  }

 private async sendBulkFailureNotifications(failedConnections: any[]) {
    // 1. Group the failed connections by Organization ID
    // So if a user has 3 broken connections, they only get 1 email!
    const groupedByOrg = failedConnections.reduce((acc, conn) => {
      if (!acc[conn.organizationId]) acc[conn.organizationId] = [];
      acc[conn.organizationId].push(conn.platform);
      return acc;
    }, {} as Record<string, string[]>);

    // 2. Fetch all affected Org Owners in a SINGLE database query
    const orgIds = Object.keys(groupedByOrg);
    const affectedOrgs = await this.prisma.organization.findMany({
      where: { id: { in: orgIds } },
      include: {
        members: {
          where: { role: { slug: 'org-owner' } },
          include: { user: true },
          take: 1,
        },
      },
    });

    // 3. Prepare all the email promises
    const emailPromises = affectedOrgs.map((org) => {
      const owner = org.members[0]?.user;
      const brokenPlatforms = groupedByOrg[org.id]; // e.g., ['LINKEDIN', 'TIKTOK']

      if (owner) {
        // You'll need to update your email template to accept an array of platforms!
        return this.emailService.sendConnectionBrokenEmail(
          owner.email,
          owner.firstName,
          brokenPlatforms, 
        );
      }
      return Promise.resolve(); // Ignore if no owner found
    });

    // 4. Send them all concurrently! 
    // allSettled ensures that if one email fails to send, the others still go through.
    await Promise.allSettled(emailPromises);
    this.logger.log('✅ Finished sending bulk failure notifications.');
  }
}
