import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import * as https from 'https';

@Injectable()
export class LinkedInService {
  private readonly logger = new Logger(LinkedInService.name);
  private readonly AUTH_URL = 'https://www.linkedin.com/oauth/v2';
  private readonly API_URL = 'https://api.linkedin.com/v2';

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {}

  // AUTH URL
  generateAuthUrl(state: string): string {
    const scopes = [
      'r_basicprofile',
      'w_member_social', // Post to Personal Profile
      'r_member_postAnalytics',
      'r_member_profileAnalytics',
      // 'w_member_social_feed',    // OPTIONAL: comment on others' posts
      'rw_organization_admin', // Admin access (to list pages)
      'w_organization_social', // Post to Company Page
      'r_organization_social',
      // 'r_organization_social_feed', // OPTIONAL: Reading comments on org posts
      // 'w_organization_social_feed', // OPTIONAL: Replying to comments on org posts
      'r_organization_followers',
    ].join(' ');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.get('LINKEDIN_CLIENT_ID'),
      // redirect_uri: `${this.config.get('API_URL')}/api/v1/social-connections/callback/linkedin`,
      redirect_uri: this.config.get('LINKEDIN_REDIRECT_URI'),
      state: state,
      scope: scopes,
    });

    return `${this.AUTH_URL}/authorization?${params.toString()}`;
  }

  // 2. EXCHANGE CODE
  async exchangeCode(code: string) {
    try {
      const { data } = await lastValueFrom(
        this.httpService.post(
          `${this.AUTH_URL}/accessToken`,
          new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            // redirect_uri: `${this.config.get('API_URL')}/api/v1/social-connections/callback/linkedin`,
            redirect_uri: this.config.get('LINKEDIN_REDIRECT_URI'),
            client_id: this.config.get('LINKEDIN_CLIENT_ID'),
            client_secret: this.config.get('LINKEDIN_CLIENT_SECRET'),
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        ),
      );

      console.log(data);
      // Fetch basic user info to identify the connection
      const userProfile = await this.getUserProfile(data.access_token);
      console.log(userProfile);

      return {
        providerUserId: userProfile.sub,
        providerUsername: userProfile.name,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_in
          ? new Date(Date.now() + data.expires_in * 1000)
          : null,
        scopes: data.scope ? data.scope.split(' ') : [],
      };
    } catch (error) {
      this.logger.error('LinkedIn Token Exchange Failed', error.response?.data);
      throw new BadRequestException('Invalid LinkedIn authorization code');
    }
  }

  // 3. GET IMPORTABLE PAGES (Profile + Companies)
  async getImportablePages(accessToken: string) {
    // A. Get Personal Profile
    const profile = await this.getUserProfile(accessToken);

    // B. Get Companies the user Administers
    const companies = await this.getUserCompanies(accessToken);
    console.log('companies');
    console.log(companies);

    // C. Merge them into a standard format
    const importable = [];

    // 1. Add Personal Profile
    importable.push({
      id: profile.sub,
      name: profile.name,
      username: profile.given_name,
      picture: profile.picture,
      platform: 'LINKEDIN',
      type: 'PROFILE',
      accessToken: accessToken,
    });

    // 2. Add Company Pages
    companies.forEach((company) => {
      importable.push({
        id: company.urn, // e.g. "urn:li:organization:98765"
        name: company.name,
        username: company.vanityName, // LinkedIn's version of a handle
        picture: company.logo,
        platform: 'LINKEDIN',
        type: 'PAGE',
        accessToken: accessToken,
      });
    });

    return importable;
  }

  // -----------------------------------------------------------------------
  // PRIVATE HELPERS
  // -----------------------------------------------------------------------

  // Fetch OpenID Profile
  private async getUserProfile(token: string) {
    const url = `${this.API_URL}/me?projection=(id,localizedFirstName,localizedLastName,profilePicture(displayImage~:playableStreams))`;

    try {
      const httpsAgent = new https.Agent({
        family: 4, // Force IPv4 (Disable IPv6)
        keepAlive: true,
        timeout: 30000,
      });

      const { data } = await lastValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Restli-Protocol-Version': '2.0.0',
            Accept: 'application/json',
          },
          httpsAgent,
        }),
      );

      let pictureUrl = null;
      if (data.profilePicture?.['displayImage~']?.elements?.length > 0) {
        const elements = data.profilePicture['displayImage~'].elements;
        // Usually the last element is the highest resolution
        const lastElement = elements[elements.length - 1];
        pictureUrl = lastElement?.identifiers?.[0]?.identifier;
      }

      return {
        sub: data.id,
        name: `${data.localizedFirstName} ${data.localizedLastName}`,
        given_name: data.localizedFirstName,
        picture: pictureUrl,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Legacy Profile', error.response?.data);
      throw error;
    }
  }

  // Fetch Companies
  private async getUserCompanies(token: string) {
    try {
      //  Use the projection to get Name, ID, and Logo in ONE call.
      // We ask for:
      // 1. organization: The URN (ID)
      // 2. organization~: The resolved object (Name, Logo, etc.)
      // 3. role: To filter for ADMINs only
      const aclsUrl =
        `${this.API_URL}/organizationAcls` +
        `?q=roleAssignee&state=APPROVED` +
        `&projection=(elements*(role,state,organization~(id,localizedName,vanityName,logoV2(original~:playableStreams))))`;

      const { data } = await lastValueFrom(
        this.httpService.get(aclsUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Restli-Protocol-Version': '2.0.0',
            Accept: 'application/json',
          },
          // Ideally, define httpsAgent once in your class constructor to reuse connections
          httpsAgent: new https.Agent({ family: 4, keepAlive: true }),
        }),
      );

      if (!data.elements || data.elements.length === 0) return [];

      // Map the results directly. No second API call needed!
      const companies = data.elements.map((element: any) => {
        const ALLOWED_ROLES = ['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR'];

        // If the user is just an 'ANALYST', skip this company
        if (!ALLOWED_ROLES.includes(element.role)) return null;

        const orgData = element['organization~'];
        if (!orgData) return null;

        // 2. Reconstruct URN from the ID we requested
        const orgUrn = `urn:li:organization:${orgData.id}`;

        // 3. Extract Logo
        let logoUrl = null;
        if (orgData.logoV2?.['original~']?.elements?.length > 0) {
          const images = orgData.logoV2['original~'].elements;
          logoUrl = images[images.length - 1]?.identifiers?.[0]?.identifier;
        }

        return {
          urn: orgUrn,
          id: orgData.id,
          name: orgData.localizedName,
          vanityName: orgData.vanityName,
          logo: logoUrl,
        };
      });

      // Filter out nulls (non-admins or failed parses)
      return companies.filter((c) => c !== null);
    } catch (error) {
      this.logger.error(
        'Failed to fetch LinkedIn companies',
        error?.response?.data || error.message,
      );
      return [];
    }
  }
}
