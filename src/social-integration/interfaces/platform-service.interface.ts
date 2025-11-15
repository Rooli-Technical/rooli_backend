export interface PlatformUser {
  id: string;
  username: string;
  name: string;
  profilePicture: string | null;
  metadata?: {
    accountType?: 'instagram' | 'facebook';
    pageId?: string;
    pageName?: string;
    pageAccessToken?: string;
    instagramAccountId?: string;
    isPersonalAccount?: boolean;
  };
}

export interface OAuthState {
  organizationId: string;
  userId: string;
  timestamp?: number;
}

// export interface LinkedInOAuthState {
//   userId: string;
//   timestamp?: number;
//   connectionType: 'PROFILE' | 'PAGES';
//   organizationId?: string;
// }

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string; 
}

// export interface LinkedInProfile {
//   id: string;
//   firstName?: string;
//   lastName?: string;
//   email?: string;
//   profileImage?: string;
//   raw: any;
// }

// export interface LinkedInCompanyPage {
//   id: string;
//   urn: string;
//   name: string;
//   vanityName?: string;
//   role: string;
//   logoUrl?: string;
//   permissions: string[];
// }

export interface PlatformService {
  /**
   * Validate access token credentials
   */
  validateCredentials(accessToken: string): Promise<boolean>;

  /**
   * Get user profile information
   */
 getUserProfile(accessToken: string): Promise<PlatformUser>;

  /**
   * Revoke access token (for disconnect)
   */
  revokeToken(accessToken: string): Promise<void>;

  /**
   * Get required OAuth scopes for this platform
   */
  getRequiredScopes(): string[];
}