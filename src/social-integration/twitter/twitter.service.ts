import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TWITTER_CONSTANTS,
  TwitterOAuthState,
  TwitterProfile,
} from './constants/index.constants';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import * as crypto from 'crypto';
import { TwitterApi } from 'twitter-api-v2';
import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { Prisma } from '@generated/client';
import { Platform } from '@generated/enums';

@Injectable()
export class TwitterService {
  private readonly logger = new Logger(TwitterService.name);
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly redirectUri: string;
  private client: TwitterApi;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
    private readonly httpService: HttpService,
    private readonly redisService: RedisService,
  ) {
    this.apiKey = this.configService.get<string>('X_API_KEY');
    this.apiSecret = this.configService.get<string>('X_API_SECRET');
    this.redirectUri =
      this.configService.get<string>('X_REDIRECT_URI') ??
      `${this.configService.get<string>('API_URL')}/social/twitter/auth/callback`;

    if (!this.apiKey || !this.apiSecret || !this.redirectUri) {
      throw new Error('Twitter credentials or redirect URI not configured');
    }
    this.client = new TwitterApi({
      appKey: this.apiKey,
      appSecret: this.apiSecret,
    });
  }

  // Step 1: Generate auth link (request token)
  async startAuth() {
    console.log(this.apiKey, this.apiSecret, this.redirectUri);
    const url = this.redirectUri;
    const authLink = await this.client.generateAuthLink(url);
    console.log(authLink);
    // save authLink.oauth_token_secret in Redis with key authLink.oauth_token
    await this.redisService.set(
      `twitter:oauth:${authLink.oauth_token}`,
      authLink.oauth_token_secret,
      600,
    );

    return authLink;
  }

  // Step 3: Exchange verifier for access token
  async getAccessToken(oauthToken: string, oauthVerifier: string) {
    const oauthTokenSecret = await this.redisService.get(
      `twitter:oauth:${oauthToken}`,
    );

    if (!oauthTokenSecret) {
      throw new Error('OAuth token secret not found or expired');
    }

    const tempClient = new TwitterApi({
      appKey: this.apiKey,
      appSecret: this.apiSecret,
      accessToken: oauthToken,
      accessSecret: oauthTokenSecret,
    });

    return await tempClient.login(oauthVerifier);
  }

  //  * Handle callback from Twitter, exchange code for tokens, upsert SocialAccount.
  //  */
  // async handleOAuthCallback(
  //   code: string,
  //   encryptedState: string,
  // ): Promise<{ socialAccount: any; profile: TwitterProfile }> {
  //   const state = await this.decryptAndValidateState(encryptedState);
  //   console.log(this.redirectUri);
  //   try {
  //     const twitter = new TwitterApi({
  //       clientId: this.clientId,
  //       clientSecret: this.clientSecret,
  //     });
  //     console.log(this.clientId)
  //     console.log(this.clientSecret)
  //     console.log(code)
  //     console.log(state.codeVerifier)

  //     // 1) Exchange code + codeVerifier for access token
  //     const {
  //       client: userClient,
  //       accessToken,
  //       refreshToken,
  //       expiresIn,
  //     } = await twitter.loginWithOAuth2({
  //       code,
  //       codeVerifier: state.codeVerifier,
  //       redirectUri: this.redirectUri,

  //     })

  //     // 2) Fetch profile
  //     const profile = await this.fetchProfile(userClient);

  //     // 3) Upsert into SocialAccount
  //     const socialAccount = await this.upsertSocialAccount(
  //       profile,
  //       {
  //         accessToken,
  //         refreshToken,
  //         expiresIn,
  //       },
  //       state,
  //     );

  //     this.logger.log('Twitter account connected', {
  //       accountId: socialAccount.id,
  //       platformAccountId: socialAccount.platformAccountId,
  //       username: profile.username,
  //     });

  //     return { socialAccount, profile };
  //   } catch (error) {
  //     console.log(error);
  //     this.logger.error('Twitter OAuth callback failed', {
  //       error: error?.message,
  //       stack: error?.stack,
  //       details: error?.data,
  //     });
  //     throw new BadRequestException('Twitter OAuth failed');
  //   }
  // }

  // ========================================================================
  // BASIC API: POST A TWEET USING A CONNECTED ACCOUNT
  // ========================================================================

  /**
   * Post a tweet as a given SocialAccount.
   * This mirrors how your PlatformService-based publish flows can work.
   */
  async publishTweet(
    socialAccountId: string,
    text: string,
    options?: { replyToId?: string; mediaIds?: string[] },
  ): Promise<{ id: string; raw: any }> {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!account) {
      throw new BadRequestException('Social account not found');
    }

    if (account.platform !== Platform.X) {
      throw new BadRequestException('Social account is not a Twitter account');
    }

    const accessToken = await this.encryptionService.decrypt(
      account.accessToken,
    );

    const twitter = new TwitterApi(accessToken);
    const payload: any = { text };

    if (options?.replyToId) {
      payload.reply = { in_reply_to_tweet_id: options.replyToId };
    }
    if (options?.mediaIds?.length) {
      payload.media = { media_ids: options.mediaIds };
    }

    try {
      const response = await twitter.v2.tweet(payload);
      return { id: response.data.id, raw: response.data };
    } catch (error) {
      this.logger.error('Failed to publish tweet', {
        socialAccountId,
        error: error?.data || error?.message,
      });
      throw new InternalServerErrorException('Failed to publish tweet');
    }
  }

  // ========================================================================
  // HELPERS: PROFILE / STATE / UPSERT
  // ========================================================================

  /**
   * Fetch current user's profile via Twitter API v2.
   */
  private async fetchProfile(userClient: TwitterApi): Promise<TwitterProfile> {
    try {
      const meResp = await userClient.v2.me({
        'user.fields': ['name', 'username', 'profile_image_url'],
      });

      const raw = meResp.data;
      return {
        id: raw.id,
        name: raw.name,
        username: raw.username,
        profileImageUrl: raw.profile_image_url,
        raw,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Twitter profile', {
        error: error?.data || error?.message,
      });
      throw new InternalServerErrorException(
        'Failed to fetch Twitter user profile',
      );
    }
  }

  private async decryptAndValidateState(
    encryptedState: string,
  ): Promise<TwitterOAuthState> {
    try {
      const plain = await this.encryptionService.decrypt(encryptedState);
      const parsed: TwitterOAuthState = JSON.parse(plain);

      const age = Date.now() - parsed.timestamp;
      if (age > TWITTER_CONSTANTS.OAUTH_STATE_MAX_AGE_MS) {
        throw new Error('OAuth state expired');
      }
      console.log('Decrypted Twitter OAuth state:', parsed);
      return parsed;
    } catch (error) {
      this.logger.warn('Twitter state validation failed', {
        error: error?.message,
      });
      throw new UnauthorizedException('Invalid or expired Twitter state');
    }
  }

  /**
   * Upsert SocialAccount record for Twitter.
   * Mirrors your LinkedIn upsertSocialAccount shape.
   */
  private async upsertSocialAccount(
    profile: TwitterProfile,
    tokenData: {
      accessToken: string;
      refreshToken?: string;
      scopes?: string[];
      expiresIn?: number;
    },
    state: TwitterOAuthState,
  ) {
    const tokenExpiresAt = tokenData.expiresIn
      ? new Date(Date.now() + tokenData.expiresIn * 1000)
      : null;

    const encryptedAccessToken = await this.encryptionService.encrypt(
      tokenData.accessToken,
    );
    const encryptedRefreshToken = tokenData.refreshToken
      ? await this.encryptionService.encrypt(tokenData.refreshToken)
      : null;

    const metadata: Prisma.InputJsonValue = {
      profile: profile.raw,
      lastSyncedAt: new Date(),
    };

    const accountData = {
      platformAccountId: profile.id,
      username: profile.username,
      name: profile.name,
      displayName: profile.name,
      profileImage: profile.profileImageUrl,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt,
      refreshTokenExpiresAt: null as Date | null, // Twitter returns refresh token but not its TTL directly
      scopes: tokenData.scopes ?? TWITTER_CONSTANTS.SCOPES,
      metadata,
      isActive: true,
      accountType: 'PROFILE' as const,
      lastSyncAt: new Date(),
    };

    // If you're using organization-scoped accounts like LinkedIn/Meta:
    if (state.organizationId) {
      return this.prisma.socialAccount.upsert({
        where: {
          platform_platformAccountId: {
            platform: Platform.X,
            platformAccountId: profile.id,
          },
        },
        create: {
          organization: {
            connect: { id: state.organizationId },
          },
          platform: Platform.X,
          ...accountData,
        },
        update: accountData,
      });
    }

    // User-level account (no organization)
    const existing = await this.prisma.socialAccount.findFirst({
      where: {
        platform: Platform.X,
        platformAccountId: profile.id,
        organizationId: null,
      },
    });

    if (existing) {
      return this.prisma.socialAccount.update({
        where: { id: existing.id },
        data: accountData,
      });
    }

    return this.prisma.socialAccount.create({
      data: {
        organizationId: null,
        platform: Platform.X,
        ...accountData,
      },
    });
  }

  // ========================================================================
  // OPTIONAL: TOKEN REFRESH
  // ========================================================================

  /**
   * Refresh an OAuth2 token if expired/expiring.
   * (You must have requested "offline.access" scope for this.)
   */
  // async refreshAccessTokenIfNeeded(socialAccountId: string): Promise<boolean> {
  //   const account = await this.prisma.socialAccount.findUnique({
  //     where: { id: socialAccountId },
  //   });

  //   if (!account) {
  //     throw new BadRequestException('Social account not found');
  //   }

  //   if (account.platform !== Platform.X) return true;

  //   if (
  //     account.tokenExpiresAt &&
  //     new Date(account.tokenExpiresAt) > new Date(Date.now() + 10 * 60 * 1000)
  //   ) {
  //     // More than 10 minutes left, no need to refresh
  //     return true;
  //   }

  //   if (!account.refreshToken) {
  //     this.logger.warn('No refresh token available for Twitter account', {
  //       socialAccountId,
  //     });
  //     return false;
  //   }

  //   const refreshToken = await this.encryptionService.decrypt(
  //     account.refreshToken,
  //   );

  //   try {
  //     const twitter = new TwitterApi({
  //       clientId: this.clientId,
  //       clientSecret: this.clientSecret,
  //     });

  //     const {
  //       accessToken,
  //       refreshToken: newRefreshToken,
  //       expiresIn,
  //       scope,
  //     } = await twitter.refreshOAuth2Token(refreshToken);

  //     const encryptedAccessToken =
  //       await this.encryptionService.encrypt(accessToken);
  //     const encryptedRefreshToken = newRefreshToken
  //       ? await this.encryptionService.encrypt(newRefreshToken)
  //       : account.refreshToken;

  //     await this.prisma.socialAccount.update({
  //       where: { id: socialAccountId },
  //       data: {
  //         accessToken: encryptedAccessToken,
  //         refreshToken: encryptedRefreshToken,
  //         tokenExpiresAt: expiresIn
  //           ? new Date(Date.now() + expiresIn * 1000)
  //           : account.tokenExpiresAt,
  //         scopes: scope ?? account.scopes,
  //         lastSyncAt: new Date(),
  //       },
  //     });

  //     this.logger.log('Twitter token refreshed', { socialAccountId });
  //     return true;
  //   } catch (error) {
  //     this.logger.error('Failed to refresh Twitter token', {
  //       socialAccountId,
  //       error: error?.message,
  //     });
  //     return false;
  //   }
  // }
}
