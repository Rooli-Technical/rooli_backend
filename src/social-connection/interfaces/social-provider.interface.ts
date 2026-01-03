export interface OAuthResult {
  providerUserId: string;
  providerUsername?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

export interface SocialPageOption {
  id: string;              // The Platform ID (e.g. FB Page ID)
  name: string;            // "Nike Official"
  picture?: string;
  platform: 'FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN' | 'TWITTER' | 'TIKTOK';
  type: 'PAGE' | 'PROFILE' | 'GROUP';
  accessToken?: string;    // The specific Page Token (if available immediately)
  username: string;
}