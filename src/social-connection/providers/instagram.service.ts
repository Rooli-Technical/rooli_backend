import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  

  private readonly AUTH_HOST = 'https://www.instagram.com';
  private readonly API_HOST = 'https://api.instagram.com';
  private readonly GRAPH_HOST = 'https://graph.instagram.com';

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {}

  generateAuthUrl(state: string): string {
    const clientId = this.config.get('INSTAGRAM_CLIENT_ID');
    const redirectUri = this.config.get('INSTAGRAM_CALLBACK_URL'); 

    const scopes = [
      'instagram_business_basic',
      'instagram_business_manage_insights',
      'instagram_business_content_publish',
      'instagram_business_manage_messages',
    ].join(',');

    return (
      `${this.AUTH_HOST}/oauth/authorize?` +
      `client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scopes}&response_type=code&state=${state}`
    );
  }

  async exchangeCode(code: string) {
    const clientId = this.config.get('INSTAGRAM_CLIENT_ID');
    const clientSecret = this.config.get('INSTAGRAM_CLIENT_SECRET');
    const redirectUri = this.config.get('INSTAGRAM_CALLBACK_URL');

    try {
      // 1. Exchange Code for Short-Lived Token
      const params = new URLSearchParams();
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);
      params.append('grant_type', 'authorization_code');
      params.append('redirect_uri', redirectUri);
      params.append('code', code);

      const { data: shortTokenData } = await lastValueFrom(
        this.httpService.post(`${this.API_HOST}/oauth/access_token`, params)
      );

      // 2. Exchange Short-Lived for Long-Lived Token (60 Days)
      const { data: longTokenData } = await lastValueFrom(
        this.httpService.get(`${this.GRAPH_HOST}/access_token`, {
          params: {
            grant_type: 'ig_exchange_token',
            client_secret: clientSecret,
            access_token: shortTokenData.access_token,
          },
        }),
      );

      // 3. Get User Profile (to confirm it's a Professional Account)
      const { data: userProfile } = await lastValueFrom(
        this.httpService.get(`${this.GRAPH_HOST}/me`, {
          params: {
            fields: 'id,username,account_type,name,profile_picture_url',
            access_token: longTokenData.access_token,
          },
        }),
      );

      // GUARD: Ensure it is not a Personal account
      // "Instagram Login" flow supports BUSINESS and CREATOR.
      // Personal accounts might log in but will fail on publishing APIs.
      if (userProfile.account_type === 'PERSONAL') {
        throw new BadRequestException('Rooli requires a Professional (Creator/Business) Instagram account.');
      }

      return {
        providerUserId: userProfile.id,
        providerUsername: userProfile.username,
        accessToken: longTokenData.access_token,
        expiresAt: new Date(Date.now() + (longTokenData.expires_in * 1000)),
        accountType: userProfile.account_type, 
        scopes: [], // IG doesn't return scopes in token response usually

      };

    } catch (error) {
      this.logger.error('IG (No-Page) Exchange Failed', error.response?.data || error.message);
      throw new BadRequestException(error.message || 'Failed to connect Instagram account');
    }
  }

  // 3. GET ACCOUNT (Importable Page)
  async getAccount(accessToken: string) {
    try {
      const { data } = await lastValueFrom(
        this.httpService.get(`${this.GRAPH_HOST}/me`, {
          params: {
            access_token: accessToken,
            fields: 'id,username,name,profile_picture_url,account_type',
          },
        }),
      );

      // Ensure it's a Business/Creator account
      // (Personal accounts cannot use the Graph API for publishing)
      if (data.account_type !== 'BUSINESS' && data.account_type !== 'CREATOR') {
        throw new BadRequestException('Only Instagram Business or Creator accounts are supported.');
      }

      return [
        {
          id: data.id,
          name: data.username, // IG Name is usually the handle
          username: data.username,
          platform: 'INSTAGRAM',
          type: 'PAGE', // Treated as a Page in your system
          picture: data.profile_picture_url,
          accessToken: accessToken, // The User Token IS the Posting Token for IG Direct
        },
      ];
    } catch (error) {
      this.logger.error('IG Fetch Failed', error.response?.data);
      return [];
    }
  }
}