import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosResponse } from 'axios';
import { LINKEDIN_CONSTANTS } from './constants/index.constant';
import { TokenResponse } from '../interfaces/platform-service.interface';
import {
  LinkedInOAuthState,
  LinkedInProfile,
  LinkedInCompanyPage,
  ConnectPagesResult,
  SocialAccountMetadata,
} from './interfaces/index.interface';
import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@generated/client';
import * as https from 'https';

@Injectable()
export class LinkedInService {
  private readonly logger = new Logger(LinkedInService.name);
  private readonly redirectUri: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
  ) {
    this.clientId = this.configService.get<string>('LINKEDIN_CLIENT_ID');
    this.clientSecret = this.configService.get<string>(
      'LINKEDIN_CLIENT_SECRET',
    );
    this.redirectUri = this.configService.get<string>('LINKEDIN_REDIRECT_URI');

    if (!this.clientId || !this.clientSecret) {
      throw new Error('LinkedIn credentials not configured');
    }
  }

  // ==================== OAUTH FLOW ====================

  // PROFILE CONNECTION FLOW
  async getProfileAuthUrl(userId: string): Promise<string> {
    const state: LinkedInOAuthState = {
      userId,
      connectionType: 'PROFILE',
      timestamp: Date.now(),
    };

    return this.buildAuthUrl(state, LINKEDIN_CONSTANTS.PROFILE_SCOPES);
  }

  async getPagesAuthUrl(
    organizationId: string,
    userId: string,
  ): Promise<string> {
    const state: LinkedInOAuthState = {
      organizationId,
      userId,
      connectionType: 'PAGES',
      timestamp: Date.now(),
    };

    return this.buildAuthUrl(state, LINKEDIN_CONSTANTS.PAGES_SCOPES);
  }
  private async buildAuthUrl(
    state: LinkedInOAuthState,
    scopes: string[],
  ): Promise<string> {
    const encryptedState = await this.encryptionService.encrypt(
      JSON.stringify(state),
    );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state: encryptedState,
      scope: scopes.join(' '),
    });

    return `${LINKEDIN_CONSTANTS.AUTH_URL}/authorization?${params.toString()}`;
  }

  async handleCallback(encryptedState: string, code: string): Promise<any> {
    try {
      const state = await this.decryptAndValidateState(encryptedState);
      const tokenData = await this.exchangeCodeForToken(code);
      const profile = await this.fetchProfile(tokenData.access_token);

      if (state.connectionType === 'PROFILE') {
        return this.handleProfileConnection(profile, tokenData, state);
      } else if (state.connectionType === 'PAGES') {
        return this.handlePagesConnection(profile, tokenData, state);
      } else {
        throw new BadRequestException('Invalid connection type');
      }
    } catch (error) {
      this.logger.error('handleCallback failed', {
        error: error?.message,
        stack: error?.stack,
      });
      throw error;
    }
  }

  private async requestTokenRefresh(
    refreshToken: string,
  ): Promise<TokenResponse> {
    const url = `${LINKEDIN_CONSTANTS.AUTH_URL}/accessToken`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    try {
      const response: AxiosResponse<TokenResponse> = await firstValueFrom(
        this.httpService.post(url, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: LINKEDIN_CONSTANTS.TOKEN_REQUEST_TIMEOUT_MS,
        }),
      );

      const data = response.data;

      if (!data?.access_token) {
        this.logger.error('LinkedIn refresh response missing access_token', {
          hasData: !!data,
        });
        throw new Error('No access token received during refresh');
      }

      this.logger.debug('LinkedIn token refreshed successfully', {
        expiresIn: data.expires_in,
        hasRefreshToken: !!data.refresh_token,
      });

      return data;
    } catch (error) {
      this.logger.error('LinkedIn token refresh failed', {
        error: error?.response?.data || error?.message,
        status: error?.response?.status,
      });
      throw new InternalServerErrorException(
        'Failed to refresh LinkedIn access token',
      );
    }
  }

  private async handleProfileConnection(
    profile: LinkedInProfile,
    tokenData: TokenResponse,
    state: LinkedInOAuthState,
  ): Promise<any> {
    const socialAccount = await this.upsertSocialAccount(
      profile,
      tokenData,
      state,
      'PROFILE',
    );

    this.logger.log('LinkedIn profile account connected', {
      accountId: socialAccount.id,
      platformAccountId: socialAccount.platformAccountId,
    });

    return {
      socialAccount,
      pages: [],
      connectionType: 'PROFILE',
    };
  }

  private async handlePagesConnection(
    profile: LinkedInProfile,
    tokenData: TokenResponse,
    state: LinkedInOAuthState,
  ): Promise<any> {
    const socialAccount = await this.upsertSocialAccount(
      profile,
      tokenData,
      state,
      'PAGE',
    );

    this.logger.log('LinkedIn pages account created', {
      accountId: socialAccount.id,
      platformAccountId: socialAccount.platformAccountId,
    });

    // Discover available pages
    const availablePages = await this.fetchUserAdministeredPages(
      tokenData.access_token,
    );

    this.logger.log('Available pages discovered', {
      accountId: socialAccount.id,
      pageCount: availablePages.length,
    });

    // Store discovered pages in metadata
    await this.updateSocialAccountMetadata(socialAccount.id, {
      lastDiscoveredPages: availablePages,
    });

    return {
      socialAccount,
      availablePages,
      connectionType: 'PAGES',
    };
  }

  // ==================== PAGE CONNECTION ====================
  async connectSelectedPages(
    socialAccountId: string,
    pageIds: string[],
  ): Promise<ConnectPagesResult> {
    if (!pageIds?.length) {
      throw new BadRequestException('No page IDs provided');
    }

    const socialAccount = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!socialAccount) {
      throw new BadRequestException('Social account not found');
    }

    // Get cached pages from metadata
    const metadata = this.parseMetadata(socialAccount.metadata);
    const allPages = metadata.lastDiscoveredPages ?? [];

    if (!allPages.length) {
      throw new BadRequestException(
        'No cached pages available. Please sync pages first.',
      );
    }

    // Filter to selected pages
    const selectedPages = allPages.filter((page) => pageIds.includes(page.urn));

    if (!selectedPages.length) {
      throw new BadRequestException(
        'No valid pages found for the provided IDs',
      );
    }

    // Decrypt token once
    const accessToken = await this.encryptionService.decrypt(
      socialAccount.accessToken,
    );
    const encryptedToken = socialAccount.accessToken; // Reuse encrypted token

    // Batch connect pages
    const result = await this.batchConnectPages(
      selectedPages,
      encryptedToken,
      socialAccount,
    );

    // Update parent metadata in same transaction as last page update
    await this.updateParentAccountMetadata(
      socialAccount.id,
      selectedPages.length,
      result.connectedPages.length,
    );

    this.logger.log('Pages connection completed', {
      socialAccountId,
      requested: pageIds.length,
      selected: selectedPages.length,
      connected: result.connectedPages.length,
      failed: result.failedPages.length,
    });

    return result;
  }

  private async batchConnectPages(
    pages: LinkedInCompanyPage[],
    encryptedToken: string,
    parentAccount: any,
  ): Promise<ConnectPagesResult> {
    const results = await Promise.allSettled(
      pages.map((page) =>
        this.upsertPageAccount(page, encryptedToken, parentAccount),
      ),
    );

    const connectedPages: any[] = [];
    const failedPages: Array<{ id: string; error: string }> = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        connectedPages.push(result.value);
      } else {
        const page = pages[index];
        const errorMessage = result.reason?.message || 'Unknown error';

        this.logger.warn('Failed to connect page', {
          pageId: page.id,
          pageName: page.name,
          error: errorMessage,
        });

        failedPages.push({
          id: page.id,
          error: errorMessage,
        });
      }
    });

    return { connectedPages, failedPages };
  }

  private async upsertPageAccount(
    page: LinkedInCompanyPage,
    encryptedToken: string,
    parentSocialAccount: any,
  ): Promise<any> {
    const pageMetadata = {
      linkedInPage: {
        urn: page.urn,
        name: page.name,
        vanityName: page.vanityName,
        role: page.role,
        connectedAt: new Date(),
      }
    };

    return this.prisma.pageAccount.upsert({
      where: { platformPageId: page.urn },
      create: {
        socialAccountId: parentSocialAccount.id,
        platformPageId: page.urn,
        name: page.name,
        accessToken: encryptedToken,
        category: null,
        profilePicture: page.logoUrl,
        metadata: pageMetadata,
      },
      update: {
        name: page.name,
        profilePicture: page.logoUrl,
        accessToken: encryptedToken,
        metadata: {
          ...pageMetadata,
          linkedInPage: {
            ...pageMetadata.linkedInPage,
            lastSyncedAt: new Date(),
          },
        },
      },
    });
  }

  // ==================== PAGE SYNC ====================
  async syncPages(
    socialAccountId: string,
  ): Promise<{ availablePages: LinkedInCompanyPage[] }> {
    const socialAccount = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!socialAccount) {
      throw new BadRequestException('Social account not found');
    }

    if (socialAccount.accountType !== 'PAGE') {
      throw new BadRequestException('This account is not a pages account');
    }

    const accessToken = await this.encryptionService.decrypt(
      socialAccount.accessToken,
    );
    const availablePages = await this.fetchUserAdministeredPages(accessToken);

    // Update cached pages
    await this.updateSocialAccountMetadata(socialAccount.id, {
      lastDiscoveredPages: availablePages,
    });

    this.logger.log('Pages synced', {
      socialAccountId,
      pageCount: availablePages.length,
    });

    return { availablePages };
  }

  async getConnectedPages(socialAccountId: string): Promise<any[]> {
    const pages = await this.prisma.pageAccount.findMany({
      where: { socialAccountId },
    });

    this.logger.debug('Connected pages retrieved', {
      socialAccountId,
      count: pages.length,
    });

    return pages;
  }

  // ==================== LINKEDIN API CALLS ====================
  private async exchangeCodeForToken(code: string): Promise<TokenResponse> {
    const url = `${LINKEDIN_CONSTANTS.AUTH_URL}/accessToken`;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    try {
      const response: AxiosResponse<TokenResponse> = await firstValueFrom(
        this.httpService.post(url, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: LINKEDIN_CONSTANTS.TOKEN_REQUEST_TIMEOUT_MS,
        }),
      );

      const data = response.data;

      if (!data?.access_token) {
        this.logger.error('LinkedIn token response missing access_token', {
          hasData: !!data,
        });
        throw new Error('No access token received');
      }

      this.logger.debug('Token exchanged successfully', {
        expiresIn: data.expires_in,
        hasRefreshToken: !!data.refresh_token,
      });

      return data;
    } catch (error) {
      this.logger.error('Token exchange failed', {
        error: error?.response?.data || error?.message,
        status: error?.response?.status,
      });
      throw new InternalServerErrorException(
        'Failed to obtain access token from LinkedIn',
      );
    }
  }

  async fetchProfile(accessToken: string): Promise<LinkedInProfile> {
    this.logger.debug('Fetching LinkedIn profile');
    try {
      const httpsAgent = new https.Agent({
        family: 4, // Force IPv4 (Disable IPv6)
        keepAlive: true,
        timeout: 30000,
      });

      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'X-Restli-Protocol-Version': LINKEDIN_CONSTANTS.RESTLI_PROTOCOL_VERSION,
        Accept: 'application/json',
      };

      const response: AxiosResponse = await firstValueFrom(
        this.httpService.get(`${LINKEDIN_CONSTANTS.API_BASE_URL}/me`, {
          headers,
          httpsAgent,
          timeout: LINKEDIN_CONSTANTS.API_REQUEST_TIMEOUT_MS,
        }),
      );

      const raw = response.data;

      const firstName = raw?.firstName?.localized
        ? Object.values(raw.firstName.localized)[0]
        : raw?.localizedFirstName;

      const lastName = raw?.lastName?.localized
        ? Object.values(raw.lastName.localized)[0]
        : raw?.localizedLastName;

      const profileImage =
        this.extractLinkedInImage(raw.profilePicture) ||
        this.extractLinkedInImage(raw['profilePicture~']);

      return {
        id: raw.id,
        firstName: firstName as string,
        lastName: lastName as string,
        profileImage,
        raw,
      };
    } catch (error) {
      this.logger.error('Failed to fetch profile', error);
      throw new InternalServerErrorException(
        'Failed to fetch LinkedIn profile',
      );
    }
  }

  private async fetchUserAdministeredPages(
    accessToken: string,
  ): Promise<LinkedInCompanyPage[]> {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'X-Restli-Protocol-Version': LINKEDIN_CONSTANTS.RESTLI_PROTOCOL_VERSION,
    };

    try {
      const httpsAgent = new https.Agent({
        family: 4, // Force IPv4 (Disable IPv6)
        keepAlive: true,
        timeout: 30000,
      });

      const aclsUrl =
        `${LINKEDIN_CONSTANTS.API_BASE_URL}/organizationAcls` +
        `?q=roleAssignee` +
        `&state=APPROVED` +
        `&projection=(elements*(role,state,roleAssignee~(localizedFirstName,localizedLastName),organization~(localizedName,vanityName,logoV2)))`;

      const response: AxiosResponse = await firstValueFrom(
        this.httpService.get(aclsUrl, {
          headers,
          httpsAgent,
          timeout: LINKEDIN_CONSTANTS.API_REQUEST_TIMEOUT_MS,
        }),
      );

      const elements: any[] = response.data?.elements ?? [];

      this.logger.debug('Organization ACLs fetched', {
        elementCount: elements.length,
      });

      const pages: LinkedInCompanyPage[] = [];

      for (const element of elements) {
        console.log(element);
        try {
          const page = this.parseCompanyPageElement(element);
          if (page) {
            pages.push(page);
          }
        } catch (error) {
          this.logger.warn('Failed to parse company page element', {
            organizationUrn: element?.organization,
            error: error.message,
          });
        }
      }

      this.logger.log(`Discovered ${pages.length} administered LinkedIn pages`);

      return pages;
    } catch (error) {
      console.log(error);
      this.logger.error('Failed to discover administered pages', {
        error: error.response?.data || error.message,
        status: error.response?.status,
      });

      if (error.response?.status === 401) {
        throw new BadRequestException('Invalid or expired access token');
      } else if (error.response?.status === 403) {
        throw new BadRequestException(
          'Insufficient permissions to access company pages',
        );
      }

      throw new InternalServerErrorException(
        'Failed to discover administered LinkedIn pages',
      );
    }
  }

  // ==================== DATABASE OPERATIONS ====================
  private async upsertSocialAccount(
    profile: LinkedInProfile,
    tokenData: TokenResponse,
    state: LinkedInOAuthState,
    accountType: 'PAGE' | 'PROFILE',
  ) {
    
    const tokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    const refreshTokenExpiresAt = tokenData.refresh_token_expires_in
      ? new Date(Date.now() + tokenData.refresh_token_expires_in * 1000)
      : null;

    const grantedScopes =
      tokenData.scope?.split(/[\s,]+/).filter(Boolean) ??
      this.configService
        .get<string>('LINKEDIN_SCOPES', '')
        .split(/[\s,]+/)
        .filter(Boolean);

    const encryptedAccessToken = await this.encryptionService.encrypt(
      tokenData.access_token,
    );

    const encryptedRefreshToken = tokenData.refresh_token
      ? await this.encryptionService.encrypt(tokenData.refresh_token)
      : null;

      const dbPlatformAccountId = accountType === 'PAGE' 
      ? `PAGE-${profile.id}` 
      : profile.id;

    const displayName =
      `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim();
    const username = (profile.firstName ?? '').toLowerCase();

    const accountData = {
      platformAccountId: dbPlatformAccountId,
      username,
      name: displayName,
      displayName,
      profileImage:
        profile.profileImage || profile.raw?.profilePicture?.displayImage,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt,
      refreshTokenExpiresAt,
      scopes: grantedScopes,
      isActive: true,
      accountType,
      lastSyncAt: new Date(),
    };

    if (state.organizationId) {
      // Organization-scoped account
      return this.prisma.socialAccount.upsert({
        where: {
          platform_platformAccountId: {
            platform: 'LINKEDIN',
            platformAccountId: dbPlatformAccountId,
          },
        },
        create: {
          organization: {
            connect: { id: state.organizationId },
          },
          platform: 'LINKEDIN',
          ...accountData,
        },
        update: accountData,
      });
    } else {
      // User-level account
      const existing = await this.prisma.socialAccount.findFirst({
        where: {
          platform: 'LINKEDIN',
          platformAccountId: dbPlatformAccountId,
        },
      });

      if (existing) {
        return this.prisma.socialAccount.update({
          where: { id: existing.id },
          data: accountData,
        });
      } else {
        return this.prisma.socialAccount.create({
          data: {
            platform: 'LINKEDIN',
            ...accountData,
          },
        });
      }
    }
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

  private async updateParentAccountMetadata(
    parentAccountId: string,
    pagesFound: number,
    pagesConnected: number,
  ): Promise<void> {
    try {
      const account = await this.prisma.socialAccount.findUnique({
        where: { id: parentAccountId },
        select: { metadata: true },
      });

      if (!account) {
        this.logger.warn('Parent account not found for metadata update', {
          parentAccountId,
        });
        return;
      }

      const existingMeta = this.parseMetadata(account.metadata);

      const merged: SocialAccountMetadata = {
        ...existingMeta,
        pageConnection: {
          pagesFound,
          pagesConnected,
        },
      };

      await this.prisma.socialAccount.update({
        where: { id: parentAccountId },
        data: {
          metadata: merged as Prisma.InputJsonValue,
          lastSyncAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.warn('Failed to update parent account metadata', {
        parentAccountId,
        error: error.message,
      });
    }
  }

  // ==================== HELPER METHODS ====================
  private async decryptAndValidateState(
    encryptedState: string,
  ): Promise<LinkedInOAuthState> {
    try {
      const plain = await this.encryptionService.decrypt(encryptedState);
      const parsed: LinkedInOAuthState = JSON.parse(plain);

      if (!parsed?.timestamp) {
        throw new Error('Invalid state payload: missing timestamp');
      }

      const age = Date.now() - parsed.timestamp;
      if (age > LINKEDIN_CONSTANTS.OAUTH_STATE_MAX_AGE_MS) {
        throw new Error(`State token expired (age: ${age}ms)`);
      }

      if (!['PROFILE', 'PAGES'].includes(parsed.connectionType)) {
        throw new Error('Invalid connection type');
      }

      return parsed;
    } catch (error) {
      this.logger.warn('State validation failed', {
        error: error?.message,
      });
      throw new BadRequestException('Invalid or expired state token');
    }
  }

  private parseCompanyPageElement(element: any): LinkedInCompanyPage | null {
    if (!element?.role || !element.organization) {
      return null;
    }

    if (element.state && element.state !== 'APPROVED') {
      return null;
    }

    const orgObj = element['organization~'];
    const urn: string = element.organization;

    const name = orgObj?.localizedName;
    const vanityName = orgObj?.vanityName;
    const logoUrl =
      this.extractLinkedInImage(orgObj.logoV2) ||
      this.extractLinkedInImage(orgObj['logoV2~']);

    return {
      id: element.id,
      urn,
      name,
      vanityName,
      role: element.role,
      logoUrl,
    };
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

  private extractLinkedInImage(artifact: any): string | null {
    if (!artifact) return null;

    //  Direct "original" projection (if simple)
    if (typeof artifact.original === 'string') return artifact.original;

    //  "displayImage" or "logoV2" acting as a VectorImage
    // usually found inside "elements" if you didn't project "original"
    const elements = artifact.elements || artifact['displayImage~']?.elements;

    if (Array.isArray(elements) && elements.length > 0) {
      // Usually the last element is the largest resolution
      const lastElement = elements[elements.length - 1];

      // Check identifiers
      if (lastElement?.identifiers?.[0]?.identifier) {
        return lastElement.identifiers[0].identifier;
      }
    }

    return null;
  }
}
