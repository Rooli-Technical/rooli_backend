import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class TikTokService {
  private readonly logger = new Logger(TikTokService.name);
  private readonly AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
  private readonly API_URL = 'https://open.tiktokapis.com/v2';

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {}

  // -------------------------------------------------------
  // 1. GENERATE AUTH URL
  // -------------------------------------------------------
  generateAuthUrl(state: string): string {
    const clientKey = this.config.get<string>('TIKTOK_CLIENT_KEY');
    const redirectUri = this.config.get<string>('TIKTOK_CALLBACK_URL');

    const scopes = [
      'user.info.basic',
      'user.info.profile',
      'user.info.stats',
      'video.list',
      'video.publish',
      'video.upload',
    ].join(',');

    return (
      `${this.AUTH_URL}?client_key=${clientKey}` +
      `&response_type=code&scope=${scopes}&redirect_uri=${redirectUri}&state=${state}`
    );
  }

  // -------------------------------------------------------
  // 2. EXCHANGE CODE
  // -------------------------------------------------------
  async exchangeCode(code: string) {
    const clientKey = this.config.get<string>('TIKTOK_CLIENT_KEY');
    const clientSecret = this.config.get<string>('TIKTOK_CLIENT_SECRET');
    const redirectUri = this.config.get<string>('TIKTOK_CALLBACK_URL');

    try {
      // Step A: Exchange Code for Access Token
      // TikTok requires form-urlencoded for the token endpoint
      const params = new URLSearchParams();
      params.append('client_key', clientKey!);
      params.append('client_secret', clientSecret!);
      params.append('code', code);
      params.append('grant_type', 'authorization_code');
      params.append('redirect_uri', redirectUri!);

      const { data: tokenData } = await lastValueFrom(
        this.httpService.post(
          `${this.API_URL}/oauth/token/`,
          params.toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          },
        ),
      );

      // TikTok v2 wraps successful data or errors differently
      if (tokenData.error && tokenData.error !== '0') {
        throw new Error(tokenData.error_description || 'Token exchange failed');
      }

      const accessToken = tokenData.access_token;
      const refreshToken = tokenData.refresh_token;
      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

      // Step B: Fetch User Profile
      const { data: userData } = await lastValueFrom(
        this.httpService.get(`${this.API_URL}/user/info/`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { fields: 'open_id,display_name,username,avatar_url' },
        }),
      );

      if (userData.error?.code !== 'ok' && userData.error?.code !== 0) {
        throw new Error(userData.error?.message || 'Failed to fetch user info');
      }

      const user = userData.data.user;

      return {
        providerUserId: user.open_id,
        providerUsername: user.username,
        name: user.display_name,
        picture: user.avatar_url,
        accessToken: accessToken,
        refreshToken: refreshToken,
        expiresAt,
        scopes: tokenData.scope,
      };
    } catch (error: any) {
      this.logger.error(
        'TikTok Exchange Failed',
        error.response?.data || error.message,
      );
      throw new BadRequestException('Failed to connect TikTok account');
    }
  }

  // -------------------------------------------------------
  // 3. GET ACCOUNT (Importable Page)
  // -------------------------------------------------------
  async getAccount(accessToken: string) {
    try {
      const { data } = await lastValueFrom(
        this.httpService.get(`${this.API_URL}/user/info/`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { fields: 'open_id,display_name,username,avatar_url' },
        }),
      );

      // 1. Same exact fix we used in exchangeCode!
      if (data.error?.code !== 'ok' && data.error?.code !== 0) {
        throw new Error(
          data.error?.message || 'TikTok API returned an unknown error',
        );
      }

      const user = data.data.user;

      // TikTok accounts map 1:1, so we return an array of 1
      return [
        {
          id: user.open_id,
          name: user.display_name || user.username,
          username: user.username,
          platform: 'TIKTOK',
          type: 'TIKTOK_PROFILE', // TikTok is technically a Profile, not a Page
          picture: user.avatar_url,
          accessToken: accessToken,
        },
      ];
    } catch (error: any) {
      this.logger.error(
        `TikTok Profile Fetch Failed: ${error.message}`,
        error.response?.data,
      );
      return [];
    }
  }

  // -------------------------------------------------------
  // 4. DISCONNECT
  // -------------------------------------------------------
  async disconnect(accessToken: string): Promise<void> {
    const clientKey = this.config.get<string>('TIKTOK_CLIENT_KEY');
    const clientSecret = this.config.get<string>('TIKTOK_CLIENT_SECRET');

    try {
      const params = new URLSearchParams();
      params.append('client_key', clientKey!);
      params.append('client_secret', clientSecret!);
      params.append('token', accessToken);

      await lastValueFrom(
        this.httpService.post(
          `${this.API_URL}/oauth/revoke/`,
          params.toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          },
        ),
      );
      this.logger.log(`Successfully revoked TikTok token`);
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message;
      this.logger.warn(`External TikTok revocation failed: ${errorMsg}`);
    }
  }
}
