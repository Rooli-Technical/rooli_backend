import { HttpService } from "@nestjs/axios";
import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { lastValueFrom } from "rxjs";
import { OAuthResult, SocialPageOption } from "../interfaces/social-provider.interface";

@Injectable()
export class FacebookService {
  private readonly logger = new Logger(FacebookService.name);
  private readonly GRAPH_URL = 'https://graph.facebook.com/v23.0'; 

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {}

  // -------------------------------------------------------
  //  GENERATE AUTH URL
  // -------------------------------------------------------
  generateAuthUrl(state: string): string {
    const appId = this.config.get('META_CLIENT_ID');
    const redirectUri = this.config.get('META_CALLBACK_URL');

    const scopes = [
  'email',
  'public_profile',
  'pages_show_list',
  'pages_read_engagement', // For FB Analytics
  'pages_manage_posts',    // For FB Posting
  'pages_manage_engagement', // For FB Comments/DMs
  'pages_read_user_content', // For FB Inbox (Incoming posts)
  'publish_video',           // Keep only if posting Videos to FB  
  // Instagram
  'instagram_basic',
  'instagram_content_publish', // For IG Posting
  'instagram_manage_insights', // For IG Analytics
  'instagram_manage_messages', // For IG DMs
].join(',');

    return (
      `https://www.facebook.com/v23.0/dialog/oauth?` +
      `client_id=${appId}&redirect_uri=${redirectUri}&state=${state}&scope=${scopes}&response_type=code`
    );
  }

  // -------------------------------------------------------
  // 2. EXCHANGE CODE (Includes Long-Lived Token Swap)
  // -------------------------------------------------------
  async exchangeCode(code: string): Promise<OAuthResult> {
    const appId = this.config.get('META_CLIENT_ID');
    const appSecret = this.config.get('META_CLIENT_SECRET');
    const redirectUri = this.config.get('META_CALLBACK_URL');

    try {
      // Step A: Exchange Code for Short-Lived User Token (Valid ~1 hour)
      const { data: tokenData } = await lastValueFrom(
        this.httpService.get(`${this.GRAPH_URL}/oauth/access_token`, {
          params: {
            client_id: appId,
            client_secret: appSecret,
            redirect_uri: redirectUri,
            code,
          },
        }),
      );

      const finalToken = tokenData.access_token;
      // Calculate expiry (usually 60 days from now)
      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 5184000) * 1000);

      // Step C: Fetch User Profile (ID & Name)
      const { data: userData } = await lastValueFrom(
        this.httpService.get(`${this.GRAPH_URL}/me`, {
          params: { access_token: finalToken, fields: 'id,name' },
        }),
      );

      return {
        providerUserId: userData.id,
        providerUsername: userData.name,
        accessToken: finalToken,
        expiresAt,
        scopes: tokenData.scopes
      };
    } catch (error) {
      this.logger.error(error.response?.data || error.message);
      throw new BadRequestException('Failed to exchange Facebook code');
    }
  }

  // -------------------------------------------------------
  // 3. GET IMPORTABLE PAGES & INSTAGRAM ACCOUNTS
  // -------------------------------------------------------
  async getPages(userAccessToken: string): Promise<SocialPageOption[]> {
    try {
      // Fetch Pages AND their linked Instagram Business Accounts in one call
      // "tasks" field allows us to check if the user has MODERATE/CREATE_CONTENT permissions
      const { data } = await lastValueFrom(
        this.httpService.get(`${this.GRAPH_URL}/me/accounts`, {
          params: {
            access_token: userAccessToken,
            limit: 100, // Handle pagination if user has >100 pages (advanced)
            fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url},tasks',
          },
        }),
      );

      const options: SocialPageOption[] = [];

      for (const page of data.data) {
        // OPTIONAL: Filter pages where user is just an 'ANALYST' and can't post
        // if (!page.tasks.includes('CREATE_CONTENT')) continue;

        // 1. Add the Facebook Page option
        options.push({
          id: page.id,
          name: page.name,
          platform: 'FACEBOOK',
          type: 'PAGE',
          accessToken: page.access_token,
          picture: page.picture?.data?.url,
          username: page.name, // FB Pages don't strictly have unique usernames always exposed here
        });

        // 2. Add the Linked Instagram Account (if exists)
        if (page.instagram_business_account) {
          const ig = page.instagram_business_account;
          options.push({
            id: ig.id,
            name: ig.username, 
            username: ig.username,
            platform: 'INSTAGRAM', 
            type: 'PAGE',
            picture: ig.profile_picture_url,
            //To post to IG, you use the *FB Page Token* of the parent page.
            // So we copy the same page.access_token here.
            accessToken: page.access_token, 
          });
        }
      }

      return options;
    } catch (error) {
      this.logger.error(`Error fetching FB pages: ${error.message}`);
      throw new BadRequestException('Could not fetch Facebook Pages');
    }
  }
}