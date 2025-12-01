import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TWITTER_CONSTANTS, TwitterProfile } from './constants/index.constants';
import { HttpService } from '@nestjs/axios';
import { TwitterApi } from 'twitter-api-v2';
import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
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
    this.redirectUri = this.configService.get<string>('X_REDIRECT_URI');

    if (!this.apiKey || !this.apiSecret || !this.redirectUri) {
      throw new Error('Twitter credentials or redirect URI not configured');
    }
    this.client = new TwitterApi({
      appKey: this.apiKey,
      appSecret: this.apiSecret,
    });
  }

  async startAuth(
    organizationId?: string,
    userId?: string,
  ): Promise<{ url: string; oauthToken: string }> {
    try {
      const authLink = await this.client.generateAuthLink(this.redirectUri);

      const authContext = {
        oauthTokenSecret: authLink.oauth_token_secret,
        organizationId,
        userId,
        timestamp: Date.now(),
      };

      await this.redisService.set(
        `twitter:oauth:${authLink.oauth_token}`,
        JSON.stringify(authContext),
        600, // 10 minutes
      );

      return {
        url: authLink.url,
        oauthToken: authLink.oauth_token,
      };
    } catch (error) {
      this.logger.error('Failed to generate Twitter auth URL', {
        error: error?.message,
        stack: error?.stack,
      });
      throw new InternalServerErrorException(
        'Failed to start Twitter authentication',
      );
    }
  }

  async handleOAuthCallback(
    oauthToken: string,
    oauthVerifier: string,
  ): Promise<{ socialAccount: any }> {
    try {
      const contextString = await this.redisService.get(
        `twitter:oauth:${oauthToken}`,
      );
      if (!contextString) {
        throw new BadRequestException(
          'OAuth session expired or invalid. Please start the authentication process again.',
        );
      }

      const context = JSON.parse(contextString);
      const { oauthTokenSecret, organizationId, userId } = context;

      await this.redisService.del(`twitter:oauth:${oauthToken}`);

      if (!oauthTokenSecret) {
        throw new BadRequestException('Invalid OAuth session');
      }

      const tempClient = new TwitterApi({
        appKey: this.apiKey,
        appSecret: this.apiSecret,
        accessToken: oauthToken,
        accessSecret: oauthTokenSecret,
      });

      console.log(tempClient);

      const {
        client: userClient,
        accessToken,
        accessSecret,
      } = await tempClient.login(oauthVerifier);

      const profile = await this.fetchProfile(userClient);

      // 7. Upsert SocialAccount record
      const socialAccount = await this.upsertSocialAccount(
        profile,
        {
          accessToken,
          accessSecret,
        },
        {
          organizationId,
          userId,
        },
      );

      this.logger.log('Twitter account connected successfully', {
        accountId: socialAccount.id,
        platformAccountId: socialAccount.platformAccountId,
        username: profile.username,
        organizationId,
      });

      return { socialAccount };
    } catch (error) {
      this.logger.error('Twitter OAuth callback failed', {
        error: error?.message,
        stack: error?.stack,
        oauthToken,
      });

      // Handle specific Twitter API errors
      if (error?.code === 401) {
        throw new UnauthorizedException(
          'Twitter authentication failed. The verification code may be invalid.',
        );
      }

      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }

      throw new BadRequestException(
        'Failed to complete Twitter authentication',
      );
    }
  }

  private async upsertSocialAccount(
    profile: TwitterProfile,
    tokenData: {
      accessToken: string;
      accessSecret: string;
    },
    context?: {
      organizationId?: string;
      userId?: string;
    },
  ) {
    const encryptedAccessToken = await this.encryptionService.encrypt(
      tokenData.accessToken,
    );
    const encryptedAccessSecret = await this.encryptionService.encrypt(
      tokenData.accessSecret,
    );

    const metadata = {
    profile: {
      description: profile.description,
      verified: profile.verified,
      location: profile.location,
      createdAt: profile.createdAt,
      profileImageUrl: profile.profileImageUrl,
    },
    public_metrics: {
      followers_count: profile.followersCount,
      following_count: profile.followingCount,
      tweet_count: profile.tweetCount,
      listed_count: profile.listedCount,
      like_count: profile.likeCount,
      media_count: profile.mediaCount,
    },
  }


    const accountData = {
      platformAccountId: profile.id,
      username: profile.username,
      name: profile.name,
      displayName: profile.name,
      profileImage: profile.profileImageUrl,
      accessToken: encryptedAccessToken,
      accessSecret: encryptedAccessSecret,
      scopes: TWITTER_CONSTANTS.SCOPES,
      isActive: true,
      accountType: 'PROFILE' as const,
      lastSyncAt: new Date(),
      metadata
    };

    // Add connectedById if we have userId
    if (context?.userId) {
      accountData['connectedById'] = context.userId;
    }

    // Save or update SocialAccount
    const whereClause = {
      platform: Platform.X,
      platformAccountId: profile.id,
      organizationId: context?.organizationId ?? null,
    };

    const existing = await this.prisma.socialAccount.findFirst({
      where: whereClause,
    });

    if (existing) {
      return this.prisma.socialAccount.update({
        where: { id: existing.id },
        data: {
          ...accountData,
          platform: Platform.X,
          organizationId: context?.organizationId ?? null,
        },
      });
    }

    return this.prisma.socialAccount.create({
      data: {
        ...accountData,
        platform: Platform.X,
        organizationId: context?.organizationId ?? null,
      },
    });
  }

  private async fetchProfile(userClient: TwitterApi): Promise<TwitterProfile> {
    try {
      const response = await userClient.v2.me({
        expansions: ['pinned_tweet_id'],
        'user.fields': [
          'id',
          'name',
          'username',
          'profile_image_url',
          'created_at',
          'description',
          'public_metrics',
          'verified',
          'location'
        ],
      });

      console.log(response);

      return {
        id: response.data.id,
        name: response.data.name,
        username: response.data.username,
        profileImageUrl: response.data.profile_image_url,
        description: response.data.description || '',
        verified: response.data.verified || false,
        followersCount: response.data.public_metrics?.followers_count || 0,
        followingCount: response.data.public_metrics?.following_count || 0,
        tweetCount: response.data.public_metrics?.tweet_count || 0,
        listedCount: response.data.public_metrics?.listed_count || 0,
        likeCount: response.data.public_metrics?.like_count || 0,
        mediaCount: response.data.public_metrics?.media_count || 0,
        location: response.data.location,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Twitter profile', {
        error: error?.message,
        details: error?.data,
      });
      throw new InternalServerErrorException('Failed to fetch Twitter profile');
    }
  }
}
