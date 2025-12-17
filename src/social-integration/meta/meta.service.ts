import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { FacebookAdsApi, User, Page } from 'facebook-nodejs-business-sdk';

import { OAuthState } from '../interfaces/platform-service.interface';
import { SocialAccountMetadata } from '../linkedin/interfaces/index.interface';
import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { SocialAccountService } from '@/social-account/social-account.service';
import { Platform } from '@generated/enums';
import { Prisma } from '@generated/client';

@Injectable()
export class MetaService {
  private readonly logger = new Logger(MetaService.name);
  private readonly graphApiBase = 'https://graph.facebook.com/v23.0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly socialAccountService: SocialAccountService,
  ) {}

  /**
   * Initialize Meta SDK with access token
   */
  private initMetaAPI(accessToken: string): void {
    FacebookAdsApi.init(accessToken);
    // Set default API instance
    FacebookAdsApi.setDefaultApi(FacebookAdsApi.init(accessToken));
  }

  /**
   * Generate Business Login URL with proper scopes
   */
  async generateAuthUrl(organizationId: string, userId: string) {
    // Create state token to prevent CSRF
    const state: OAuthState = {
      organizationId,
      userId,
      timestamp: Date.now(),
    };

    const encryptedState = await this.encryptionService.encrypt(
      JSON.stringify(state),
    );

    const base = `https://www.facebook.com/v23.0/dialog/oauth`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.META_CLIENT_ID!,
      redirect_uri: this.getRedirectUri(),
      state: encryptedState,
      scope: [
        'email',
        'public_profile',
        'business_management',
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'pages_manage_engagement',
        'publish_video',
        'pages_manage_metadata',
        'pages_read_user_engagement',
        'pages_read_user_content',
        'instagram_basic',
        'instagram_manage_messages',
        'instagram_content_publish',
        'read_insights',
        'instagram_manage_insights'
      ].join(','),
    });

    return { url: `${base}?${params.toString()}` };
  }

  async handleOAuthCallback(
    code: string,
    encryptedState: string,
  ): Promise<{ success: boolean; accountId: string; pages: any[] }> {
    const stateData = await this.decryptAndValidateState(encryptedState);
    const { organizationId, userId } = stateData;

    this.logger.log(`Processing OAuth callback for organization`, {
      organizationId,
      userId,
    });

    try {
      const tokenData = await this.exchangeCodeForToken(code);

      const debugToken = await this.debugToken(tokenData.access_token);

      const userProfile = await this.getUserProfile(tokenData.access_token);

      // Get user pages with their access tokens
      const userPages = await this.getUserPages(tokenData.access_token);

      // Calculate token expiration
      const tokenExpiresAt = this.calculateTokenExpiration(
        tokenData,
        debugToken,
      );

      const encryptedAccessToken = await this.encryptionService.encrypt(
        tokenData.access_token,
      );

      // Prepare social account data (main user account)
      const accountData = {
        organizationId,
        platform: Platform.META,
        platformAccountId: userProfile.id,
        username: userProfile.username || userProfile.name,
        name: userProfile.name,
        profileImage: userProfile.profilePicture,
        accessToken: encryptedAccessToken,
        tokenExpiresAt: tokenExpiresAt ? tokenExpiresAt : null,
        scopes: debugToken.scopes || [],
        connectedBy: userId,
        metadata: {
          email: userProfile.email,
          profilePicture: userProfile.profilePicture,
          tokenType: tokenData.token_type || 'bearer',
          dataAccessExpirationTime: debugToken.data_access_expires_at,
          grantedScopes: debugToken.scopes,
        },
      };

      // Store or update main social account
      const socialAccount =
        await this.socialAccountService.upsertSocialAccount(accountData);

      await this.updateSocialAccountMetadata(socialAccount.id, {
        lastDiscoveredPages: userPages,
      });

      // Store pages in PageAccount model
      //await this.syncUserPages(socialAccount.id, userPages);

      this.logger.log(
        `Successfully connected Meta account ${userProfile.name} with ${userPages.length} pages`,
        { accountId: socialAccount.id, organizationId },
      );

      return {
        success: true,
        accountId: socialAccount.id,
        pages: userPages,
      };
    } catch (error) {
      this.logger.error('Meta OAuth callback failed', {
        error: error.message,
        stack: error.stack,
        organizationId,
      });
      throw new BadRequestException(`Meta OAuth failed: ${error.message}`);
    }
  }

  async connectSelectedPages(
    socialAccountId: string,
    pageIds: string[],
  ): Promise<{ connectedPages: any[]; failedPages: string[] }> {
    if (!pageIds?.length) {
      throw new BadRequestException('No page IDs provided');
    }

    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
      select: { metadata: true, id: true },
    });

    if (!account) {
      throw new NotFoundException('Social account not found');
    }

    const metadata = (account.metadata || {}) as any;
    const allPages: any[] = metadata.lastDiscoveredPages ?? [];

    if (!allPages.length) {
      throw new BadRequestException('No cached pages available to connect');
    }

    const selectedPages = allPages.filter((p) => pageIds.includes(p.id));

    if (!selectedPages.length) {
      throw new BadRequestException('No valid pages found for provided IDs');
    }

    const results = await this.syncUserPages(socialAccountId, selectedPages);

    // You can compute successes/failures from results if you want
    return {
      connectedPages: results,
      failedPages: [],
    };
  }

  private async updateSocialAccountMetadata(
    accountId: string,
    updates: Partial<SocialAccountMetadata>,
  ): Promise<void> {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: accountId },
      select: { metadata: true },
    });

    if (!account) {
      throw new BadRequestException('Social account not found');
    }

    const existingMeta = this.parseMetadata(account.metadata);

    const merged: SocialAccountMetadata = {
      ...existingMeta,
      ...updates,
    };

    await this.prisma.socialAccount.update({
      where: { id: accountId },
      data: {
        metadata: merged as Prisma.InputJsonValue,
        lastSyncAt: new Date(),
      },
    });
  }

  private parseMetadata(metadata: unknown): SocialAccountMetadata {
    if (this.isValidObject(metadata)) {
      return metadata as SocialAccountMetadata;
    }
    return {};
  }

  private isValidObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  /**
   * Exchange code for access token
   */
  private async exchangeCodeForToken(code: string): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
  }> {
    const tokenUrl = `${this.graphApiBase}/oauth/access_token`;
    const params = new URLSearchParams({
      client_id: process.env.META_CLIENT_ID!,
      client_secret: process.env.META_CLIENT_SECRET!,
      redirect_uri: this.getRedirectUri(),
      code,
    });

    const response = await fetch(`${tokenUrl}?${params.toString()}`);
    const data = await response.json();

    if (!response.ok || data.error) {
      this.logger.error('Token exchange failed', data.error);
      throw new Error(
        data.error?.message || 'Failed to exchange code for token',
      );
    }

    return data;
  }

  /**
   * Get user pages with their access tokens
   */
  async getUserPages(userAccessToken: string): Promise<any[]> {
    try {
      this.initMetaAPI(userAccessToken);
      const me = new User('me');

      const accounts = await me.getAccounts([
        'id',
        'name',
        'access_token',
        'category',
        'instagram_business_account{id,username,name,profile_picture_url}',
        'link',
        'picture{url}',
        'tasks', // What the user can do on this page
      ]);

      return accounts.map((account) => ({
        id: account.id,
        name: account.name,
        access_token: account.access_token, // Page-specific access token
        category: account.category,
        instagram_business_account: account.instagram_business_account,
        link: account.link,
        picture: account.picture?.url,
        tasks: account.tasks,
        can_post: account.tasks?.includes('CREATE_CONTENT') || false,
      }));
    } catch (error) {
      this.logger.error('Error fetching Meta pages', { error: error.message });
      throw new BadRequestException('Could not fetch user pages');
    }
  }

  /**
   * Store or update all pages connected to a social account in PageAccount model
   */
  async syncUserPages(socialAccountId: string, pages: any[]): Promise<any[]> {
    try {
      const pageRecords = await Promise.all(
        pages.map(async (page) => {
          const encryptedToken = await this.encryptionService.encrypt(
            page.access_token,
          );

          const igAccount = page.instagram_business_account;

          return this.prisma.pageAccount.upsert({
            where: { platformPageId: page.id },
            update: {
              name: page.name,
              category: page.category,
              accessToken: encryptedToken,
              instagramBusinessId: igAccount?.id,
              instagramUsername: igAccount?.username,
              profilePicture: page.picture || null, // or custom fetch below
              metadata: {
                link: page.link,
                category: page.category,
                instagramData: igAccount,
                tasks: page.tasks,
                lastSynced: new Date(),
              },
              updatedAt: new Date(),
            },
            create: {
              platformPageId: page.id,
              name: page.name,
              category: page.category,
              accessToken: encryptedToken,
              instagramBusinessId: igAccount?.id,
              instagramUsername: igAccount?.username,
              profilePicture: page.picture || null,
              socialAccountId,
              metadata: {
                link: page.link,
                category: page.category,
                instagramData: igAccount,
                tasks: page.tasks,
                canPost: page.tasks?.includes('CREATE_CONTENT') || false,
                lastSynced: new Date(),
              },
            },
          });
        }),
      );

      this.logger.log(
        `Synced ${pageRecords.length} Facebook pages (and linked Instagram accounts if available) for social account ${socialAccountId}`,
      );
      return pageRecords;
    } catch (error) {
      this.logger.error('Failed to sync user pages', {
        message: error.message,
        stack: error.stack,
      });
      throw new BadRequestException('Could not sync Facebook/Instagram pages');
    }
  }

  /**
   * Get decrypted access token for API calls
   */
  async getDecryptedAccessToken(socialAccountId: string): Promise<string> {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
      select: { accessToken: true },
    });

    if (!account) {
      throw new NotFoundException('Social account not found');
    }

    return await this.encryptionService.decrypt(account.accessToken);
  }

  /**
   * Refresh token if expired
   */
async refreshAccessToken(socialAccountId: string): Promise<void> {
  const account = await this.prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
    select: { accessToken: true }
  });

  // Decrypt current token
  const currentToken = await this.encryptionService.decrypt(account.accessToken);

  // Meta "Refresh" is actually just exchanging the old token for a new long-lived one
  const url = `${this.graphApiBase}/oauth/access_token`;
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_CLIENT_ID!,
    client_secret: process.env.META_CLIENT_SECRET!,
    fb_exchange_token: currentToken,
  });

  const response = await fetch(`${url}?${params.toString()}`);
  const data = await response.json();

  if (data.access_token) {
    // SAVE TO DB
    await this.prisma.socialAccount.update({
      where: { id: socialAccountId },
      data: {
        accessToken: await this.encryptionService.encrypt(data.access_token),
        // Update expiration if provided (usually 60 days)
        tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined
      }
    });
    this.logger.log(`Refreshed Meta token for ${socialAccountId}`);
  } else {
    throw new Error('Meta token refresh failed');
  }
}

  /**
   * Decrypt and validate OAuth state with expiration
   */
  private async decryptAndValidateState(
    encryptedState: string,
  ): Promise<OAuthState> {
    try {
      const decryptedState =
        await this.encryptionService.decrypt(encryptedState);
      const stateData: OAuthState = JSON.parse(decryptedState);

      // Validate required fields
      if (!stateData.organizationId || !stateData.userId) {
        throw new Error('Invalid state data: missing required fields');
      }

      // Validate timestamp (prevent replay attacks, 10-minute expiration)
      if (
        !stateData.timestamp ||
        Date.now() - stateData.timestamp > 10 * 60 * 1000
      ) {
        throw new Error('OAuth state expired');
      }

      return stateData;
    } catch (error) {
      this.logger.error('Failed to decrypt OAuth state:', error);
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
  }
  /**
   * Debug token to get detailed information
   */
  private async debugToken(accessToken: string): Promise<any> {
    const response = await fetch(
      `${this.graphApiBase}/debug_token?input_token=${accessToken}&access_token=${this.getAppAccessToken()}`,
    );
    const data = await response.json();
    console.log('Debug Token Response:', data);

    if (!response.ok || data.error || !data.data?.is_valid) {
      throw new Error(data.error?.message || 'Invalid token');
    }

    return data.data;
  }

  /**
   * Get app access token for debug purposes
   */
  private getAppAccessToken(): string {
    return `${process.env.META_CLIENT_ID!}|${process.env.META_CLIENT_SECRET!}`;
  }

  /**
   * Verify user access token validity and get user info using SDK
   */
  async verifyUserAccessToken(userAccessToken: string): Promise<{
    userId: string;
    scopes: string[];
    expiresAt: Date | null;
    isValid: boolean;
  }> {
    try {
      this.initMetaAPI(userAccessToken);

      // Use SDK for token verification
      const debugToken = await this.debugToken(userAccessToken);

      return {
        userId: debugToken.user_id,
        scopes: debugToken.scopes || [],
        expiresAt: debugToken.expires_at
          ? new Date(debugToken.expires_at * 1000)
          : null,
        isValid: debugToken.is_valid,
      };
    } catch (error) {
      this.logger.error('Error verifying Meta token', error);
      throw new UnauthorizedException('Invalid or expired Facebook token');
    }
  }

  /**
   * Get user profile information using SDK
   */
  async getUserProfile(userAccessToken: string): Promise<{
    id: string;
    name: string;
    email?: string;
    username?: string;
    profilePicture?: string;
  }> {
    try {
      this.initMetaAPI(userAccessToken);
      const me = new User('me');

      const user = await me.get(['id', 'name', 'email', 'picture{url}']);

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        profilePicture: user.picture?.url,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Meta user profile', error);
      throw new BadRequestException('Unable to fetch Facebook user profile');
    }
  }

  /**
   * Get all businesses the user manages using SDK
   */
  async getUserBusinesses(userAccessToken: string): Promise<any[]> {
    try {
      this.initMetaAPI(userAccessToken);
      const me = new User('me');

      const businesses = await me.getBusinesses([
        'id',
        'name',
        'vertical',
        'created_time',
      ]);

      return businesses.map((business) => ({
        id: business.id,
        name: business.name,
        vertical: business.vertical,
        createdTime: business.created_time,
      }));
    } catch (error) {
      this.logger.error('Failed to fetch businesses', error);
      throw new BadRequestException('Unable to fetch Facebook businesses');
    }
  }

  /**
   * Get Instagram business account linked to a Facebook page
   */
  async getInstagramBusinessAccount(
    pageId: string,
    pageAccessToken: string,
  ): Promise<any> {
    try {
      this.initMetaAPI(pageAccessToken);
      const page = new Page(pageId);

      const instagramAccount = await page.get([
        'instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count}',
      ]);

      return instagramAccount.instagram_business_account || null;
    } catch (error) {
      this.logger.error(
        'Error fetching Instagram business account',
        error.message,
      );
      return null;
    }
  }

  /**
   * Revoke app permissions (disconnect) using HTTP call
   */
  async revokeToken(accessToken: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.graphApiBase}/me/permissions?access_token=${accessToken}`,
        { method: 'DELETE' },
      );
      const result = await response.json();

      if (!result.success) {
        throw new Error('Failed to revoke Meta token permissions');
      }

      this.logger.log('Meta token permissions revoked successfully');
    } catch (error) {
      this.logger.error('Error revoking Meta token', error);
      throw new BadRequestException('Failed to revoke token permissions');
    }
  }

  /**
   * Validate access token quickly using SDK
   */
  async validateAccessToken(accessToken: string): Promise<boolean> {
    try {
      this.initMetaAPI(accessToken);
      const me = new User('me');

      // Simple call to validate token
      await me.get(['id']);
      return true;
    } catch (error) {
      this.logger.warn('Meta token validation failed', error);
      return false;
    }
  }

  private calculateTokenExpiration(
    tokens: any,
    debugToken?: any,
  ): Date | undefined {
    if (debugToken?.expires_at && debugToken.expires_at > 0) {
      return new Date(debugToken.expires_at * 1000);
    }

    if (tokens?.expires_in && tokens.expires_in > 0) {
      return new Date(Date.now() + tokens.expires_in * 1000);
    }

    if (debugToken?.data_access_expires_at) {
      // Use data access expiration as fallback (for long-lived tokens)
      return new Date(debugToken.data_access_expires_at * 1000);
    }

    return undefined; // token might not expire
  }

  private getRedirectUri(): string {
    return `${process.env.META_CALLBACK_URL}`;
  }
}
