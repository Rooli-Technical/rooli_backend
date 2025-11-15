export const LINKEDIN_CONSTANTS = {
  AUTH_URL: 'https://www.linkedin.com/oauth/v2',
  API_BASE_URL: 'https://api.linkedin.com/v2',
  OAUTH_STATE_MAX_AGE_MS: 15 * 60 * 1000, // 15 minutes
  TOKEN_REQUEST_TIMEOUT_MS: 30000,
  API_REQUEST_TIMEOUT_MS: 15000,
  RESTLI_PROTOCOL_VERSION: '2.0.0',
  ACCEPTED_ROLES: new Set([
    'ADMINISTRATOR',
    'CONTENT_ADMINISTRATOR',
    'DIRECT_SPONSORED_CONTENT_POSTER',
    'RECRUITING_POSTER',
  ]),
  PROFILE_SCOPES: [
    'r_basicprofile',
    'w_member_social',
    'r_member_postAnalytics',
    'r_member_profileAnalytics',
    'w_member_social_feed',
  ] as string[],
  PAGES_SCOPES: [
    'r_basicprofile',
    'rw_organization_admin',
    'w_organization_social',
    'r_organization_social',
    'r_organization_social_feed',
    'w_organization_social_feed',
  ] as string[],
} as const;

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  ADMINISTRATOR: ['post', 'analyze', 'manage_settings', 'manage_admins', 'sponsored_content'],
  CONTENT_ADMINISTRATOR: ['post', 'analyze', 'sponsored_content'],
  DIRECT_SPONSORED_CONTENT_POSTER: ['sponsored_content'],
  ANALYST: ['analyze'],
};