import { RedisService } from '@/redis/redis.service';
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwitterApi } from 'twitter-api-v2';
import { OAuthResult, SocialPageOption } from '../interfaces/social-provider.interface';

@Injectable()
export class TwitterService {
  private readonly logger = new Logger(TwitterService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redisService: RedisService, 
  ) {}


  async generateAuthLink(organizationId: string): Promise<string> {
    try {
      const client = new TwitterApi({
        appKey: this.config.getOrThrow('TWITTER_API_KEY'),
        appSecret: this.config.getOrThrow('TWITTER_API_SECRET'),
      });

      const callbackUrl = this.config.get('TWITTER_REDIRECT_URI')
      
      const authLink = await client.generateAuthLink(callbackUrl, { 
        linkMode: 'authorize' 
      });

      // STORE STATE IN REDIS
      // We store the "secret" associated with this temporary token
      // We also store the organizationId so we know who is connecting later
      await this.redisService.set(
        `twitter_auth:${authLink.oauth_token}`, 
        JSON.stringify({ secret: authLink.oauth_token_secret, organizationId }), 
        600 
      );

      return authLink.url;
    } catch (error) {
      this.logger.error('Twitter Auth Link Failed', error);
      throw new BadRequestException('Could not connect to Twitter.');
    }
  }

 // 2. EXCHANGE FOR TOKENS
  async login(oauth_token: string, oauth_verifier: string): Promise<OAuthResult> {
    // A. Retrieve Secret from Redis
    const cachedData = await this.redisService.get(`twitter_auth:${oauth_token}`);
    
    if (!cachedData) {
      throw new BadRequestException('Twitter session expired. Please try again.');
    }

    const { secret } = JSON.parse(cachedData);

    try {
      // B. Create Client with Temporary Creds
      const client = new TwitterApi({
        appKey: this.config.getOrThrow('TWITTER_API_KEY'),
        appSecret: this.config.getOrThrow('TWITTER_API_SECRET'),
        accessToken: oauth_token,
        accessSecret: secret,   
      });

      // C. Exchange for Permanent User Tokens
      const { accessToken, accessSecret, userId, screenName } = await client.login(oauth_verifier);

      // Cleanup
      await this.redisService.del(`twitter_auth:${oauth_token}`);

      return {
        providerUserId: userId,
        providerUsername: screenName,
        accessToken: accessToken, 
        // We use the 'refreshToken' field to store the 'Access Secret' 
        // because we need BOTH to post.
        refreshToken: accessSecret, 
        scopes: ['tweet.read', 'tweet.write', 'users.read'],
        expiresAt: null 
      };

    } catch (error) {
      this.logger.error('Twitter Verification Failed', error);
      throw new BadRequestException('Invalid Twitter credentials.');
    }
  }

  // 3. GET IMPORTABLE (Just the Profile)
  async getProfile(accessToken: string, accessSecret: string): Promise<SocialPageOption[]> {
    const client = new TwitterApi({
      appKey: this.config.getOrThrow('TWITTER_API_KEY'),
      appSecret: this.config.getOrThrow('TWITTER_API_SECRET'),
      accessToken,
      accessSecret,
    });

    const currentUser = await client.v1.verifyCredentials();

    return [{
      id: currentUser.id_str,
      name: currentUser.name,       // "John Doe"
      username: currentUser.screen_name, // "@johndoe"
      picture: currentUser.profile_image_url_https,
      platform: 'TWITTER',
      type: 'PROFILE',
      accessToken: accessToken, // We only pass the token here (Secret is looked up via Connection later)
    }];
  }
}