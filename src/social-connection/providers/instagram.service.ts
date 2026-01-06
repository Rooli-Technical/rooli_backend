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

  // 1. AUTH URL
  generateAuthUrl(state: string): string {
    const clientId = this.config.get('INSTAGRAM_CLIENT_ID');
    const redirectUri = this.config.get('INSTAGRAM_CALLBACK_URL'); 

    // Scopes specific to "Instagram for Business"
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

  // 2. EXCHANGE CODE (With Long-Lived Swap)
  async exchangeCode(code: string) {
    const clientId = this.config.get('INSTAGRAM_CLIENT_ID');
    const clientSecret = this.config.get('INSTAGRAM_CLIENT_SECRET');
    const redirectUri = this.config.get('INSTAGRAM_CALLBACK_URL');

    try {
      // STEP A: Get Short-Lived Token (Valid ~1 Hour)
      // Note: IG requires FORM data, not query params for this step usually, 
      // but checking docs, FormData is safer.
      const params = new URLSearchParams();
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);
      params.append('grant_type', 'authorization_code');
      params.append('redirect_uri', redirectUri);
      params.append('code', code);

      const { data: shortData } = await lastValueFrom(
        this.httpService.post(`${this.API_HOST}/oauth/access_token`, params, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );

      const shortToken = shortData.access_token;
      const userId = shortData.user_id; // IG returns ID here

      // STEP B: Swap for Long-Lived Token (Valid ~60 Days)
      const { data: longData } = await lastValueFrom(
        this.httpService.get(`${this.GRAPH_HOST}/access_token`, {
          params: {
            grant_type: 'ig_exchange_token',
            client_secret: clientSecret,
            access_token: shortToken,
          },
        }),
      );

      const finalToken = longData.access_token;
      const expiresAt = new Date(Date.now() + (longData.expires_in || 5184000) * 1000);

      // STEP C: Get User Details (Username/Name)
      const { data: userData } = await lastValueFrom(
        this.httpService.get(`${this.GRAPH_HOST}/me`, {
          params: {
            access_token: finalToken,
            fields: 'id,username,name,profile_picture_url',
          },
        }),
      );

      return {
        providerUserId: userData.id,
        providerUsername: userData.username, // IG uses username as primary
        accessToken: finalToken,
        expiresAt,
        scopes: [], // IG doesn't return scopes in token response usually
      };
    } catch (error) {
      this.logger.error('IG Exchange Failed', error.response?.data);
      throw new BadRequestException('Failed to connect Instagram account');
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