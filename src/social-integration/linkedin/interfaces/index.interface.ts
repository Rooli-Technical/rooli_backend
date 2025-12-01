export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

export interface LinkedInOAuthState {
  userId: string;
  organizationId?: string;
  connectionType: 'PROFILE' | 'PAGES';
  timestamp: number;
}

export interface LinkedInProfile {
  id: string;
  firstName?: string;
  lastName?: string;
  profileImage?: string;
  raw: any;
}

export interface LinkedInCompanyPage {
  id: string;
  urn: string;
  name: string;
  vanityName?: string;
  role: string;
  logoUrl?: string;
}

export interface ConnectPagesResult {
  connectedPages: any[];
  failedPages: Array<{ id: string; error: string }>;
}

export interface SocialAccountMetadata {
  profile?: any;
  lastDiscoveredPages?: LinkedInCompanyPage[];
  pageConnection?: {
    pagesFound: number;
    pagesConnected: number;
  };
}

// Type guard for metadata
export function isSocialAccountMetadata(obj: any): obj is SocialAccountMetadata {
  return obj && typeof obj === 'object';
}