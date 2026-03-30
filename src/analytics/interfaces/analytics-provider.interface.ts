// ==========================================
// UNIFIED CORE METRICS
// ==========================================
export interface UnifiedAccountMetrics {
  followersTotal: number;
  impressions: number;
  reach: number;
  profileViews: number;
  clicks: number;
  engagementCount: number;
}

export interface UnifiedPostMetrics {
  postId: string;
  likes: number;
  comments: number;
  impressions: number;
  reach: number;
  engagementCount: number;
}

// ==========================================
// PLATFORM SPECIFIC METRICS
// ==========================================
// We use a flexible specific object, but you can strictly type these
// to match the Prisma tables perfectly if you prefer.
export interface FetchAccountResult {
  platformId: string;
  fetchedAt: Date;
  unified: UnifiedAccountMetrics;
  specific: any; // e.g., { demographics: {...}, customButtonClicks: 10 }
}

export interface FetchPostResult {
  unified: UnifiedPostMetrics;
  specific: any; // e.g., { retweets: 5, bookmarks: 2 }
}

export interface IAnalyticsProvider {
  getAccountStats(
    id: string,
    credentials: AuthCredentials,
  ): Promise<FetchAccountResult>;

  getPostStats(
    postIds: string[],
    credentials: AuthCredentials,
    context?: Record<string, any>,
  ): Promise<FetchPostResult[]>;
}
export interface AuthCredentials {
  accessToken: string;
  accessSecret?: string;
}

export const LINKEDIN_MAPS: Record<string, Record<string, string>> = {
  seniority: {
    'urn:li:seniority:1': 'Unpaid',
    'urn:li:seniority:2': 'Training',
    'urn:li:seniority:3': 'Entry Level',
    'urn:li:seniority:4': 'Senior',
    'urn:li:seniority:5': 'Manager',
    'urn:li:seniority:6': 'Director',
    'urn:li:seniority:7': 'VP',
    'urn:li:seniority:8': 'CXO',
    'urn:li:seniority:9': 'Partner',
    'urn:li:seniority:10': 'Owner',
  },
  // Add other maps (function, industry) as needed
};
