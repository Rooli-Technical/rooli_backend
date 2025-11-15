import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/utility/encryption.service';
import { AxiosResponse } from 'node_modules/axios/index.cjs';
import { firstValueFrom } from 'rxjs';
import {
  LINKEDIN_CONSTANTS,
  ROLE_PERMISSIONS,
} from './constants/index.constant';
import { TokenResponse } from '../interfaces/platform-service.interface';
import {
  LinkedInOAuthState,
  LinkedInProfile,
  LinkedInCompanyPage,
  ConnectPagesResult,
  SocialAccountMetadata,
} from './interfaces/index.interface';
import { Prisma } from '@prisma/client';

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
    this.redirectUri =
      this.configService.get<string>('LINKEDIN_REDIRECT_URI') ??
      `${this.configService.get<string>('API_URL')}/linkedin/auth/callback`;

    if (!this.clientId || !this.clientSecret) {
      throw new Error('LinkedIn credentials not configured');
    }
  }

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
    const selectedPages = allPages.filter((page) => pageIds.includes(page.id));

    if (!selectedPages.length) {
      throw new BadRequestException(
        'No valid pages found for the provided IDs',
      );
    }

    // Decrypt token once (not per page)
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
        id: page.id,
        urn: page.urn,
        name: page.name,
        vanityName: page.vanityName,
        role: page.role,
        permissions: page.permissions,
        connectedAt: new Date().toISOString(),
      },
      parentAccount: {
        id: parentSocialAccount.id,
        platformAccountId: parentSocialAccount.platformAccountId,
      },
    };

    return this.prisma.pageAccount.upsert({
      where: { platformPageId: page.id },
      create: {
        socialAccountId: parentSocialAccount.id,
        platformPageId: page.id,
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
            lastSyncedAt: new Date().toISOString(),
          },
        },
      },
    });
  }

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
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'X-Restli-Protocol-Version': LINKEDIN_CONSTANTS.RESTLI_PROTOCOL_VERSION,
      };

      const response: AxiosResponse = await firstValueFrom(
        this.httpService.get(`${LINKEDIN_CONSTANTS.API_BASE_URL}/me`, {
          headers,
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

      const profileImage = raw?.profilePicture?.displayImage;

      return {
        id: raw.id,
        firstName: firstName as string,
        lastName: lastName as string,
        profileImage,
        raw,
      };
    } catch (error) {
      this.logger.error('Failed to fetch profile', {
        error: error?.response?.data || error?.message,
        status: error?.response?.status,
      });
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
      const aclsUrl =
        `${LINKEDIN_CONSTANTS.API_BASE_URL}/organizationAcls` +
        `?q=roleAssignee` +
        `&state=APPROVED` +
        `&projection=(elements*(role,state,roleAssignee~(localizedFirstName,localizedLastName),organization~(localizedName,vanityName,logoV2)))`;

      const response: AxiosResponse = await firstValueFrom(
        this.httpService.get(aclsUrl, {
          headers,
          timeout: LINKEDIN_CONSTANTS.API_REQUEST_TIMEOUT_MS,
        }),
      );

      const elements: any[] = response.data?.elements ?? [];

      this.logger.debug('Organization ACLs fetched', {
        elementCount: elements.length,
      });

      const pages: LinkedInCompanyPage[] = [];

      for (const element of elements) {
        console.log(element)
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

  private async upsertSocialAccount(
    profile: LinkedInProfile,
    tokenData: TokenResponse,
    state: LinkedInOAuthState,
    accountType: 'PAGE' | 'PROFILE',
  ) {
    const tokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    const refreshTokenExpiresIn = tokenData.refresh_token_expires_in
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

    const metadata: SocialAccountMetadata = {
      profile: profile.raw,
    };

    const displayName =
      `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim();
    const username = (profile.firstName ?? '').toLowerCase();

    const accountData = {
      platformAccountId: profile.id,
      username,
      name: displayName,
      displayName,
      profileImage:
        profile.profileImage || profile.raw?.profilePicture?.displayImage,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt,
      refreshTokenExpiresIn,
      scopes: grantedScopes,
      metadata: metadata as Prisma.InputJsonValue,
      isActive: true,
      accountType,
      lastSyncAt: new Date(),
    };

    if (state.organizationId) {
      // Organization-scoped account
      return this.prisma.socialAccount.upsert({
        where: {
          organizationId_platform_platformAccountId: {
            organizationId: state.organizationId,
            platform: 'LINKEDIN',
            platformAccountId: profile.id,
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
          platformAccountId: profile.id,
          organizationId: null,
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
            organizationId: null,
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
          lastConnectedAt: new Date().toISOString(),
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

    if (!LINKEDIN_CONSTANTS.ACCEPTED_ROLES.has(element.role)) {
      return null;
    }

    const orgObj = element['organization~'];
    const urn: string = element.organization;

    const id = this.extractIdFromUrn(urn);
    if (!id) {
      return null;
    }

    const name = this.extractCompanyName(orgObj);
    const vanityName = orgObj?.vanityName;
    const logoUrl = this.extractLogoUrl(orgObj?.logoV2);
    const permissions = this.getPermissionsFromRole(element.role);

    return {
      id,
      urn,
      name,
      vanityName,
      role: element.role,
      logoUrl,
      permissions,
    };
  }

  private extractIdFromUrn(urn: string): string | null {
    if (!urn) return null;
    const parts = urn.split(':');
    return parts.length > 0 ? parts[parts.length - 1] : null;
  }

  private extractCompanyName(orgObj: any): string {
    if (!orgObj) {
      return 'Unknown Company';
    }

    const localizedName = orgObj.localizedName;

    if (typeof localizedName === 'string') {
      return localizedName;
    }

    if (this.isValidObject(localizedName)) {
      const firstValue = Object.values(localizedName)[0];
      if (typeof firstValue === 'string') {
        return firstValue;
      }
    }

    return orgObj.name || 'Unknown Company';
  }

  private extractLogoUrl(logoV2: any): string | undefined {
    console.log(logoV2)
    try {
      return logoV2?.['original~']?.elements?.[0]?.identifiers?.[0]?.identifier;
    } catch {
      return undefined;
    }
  }

  private getPermissionsFromRole(role: string): string[] {
    return ROLE_PERMISSIONS[role] ?? ['analyze'];
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
}
