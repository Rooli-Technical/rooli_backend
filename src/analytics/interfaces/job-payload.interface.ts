import { Platform } from "@generated/enums";

// Payload for 'fetch-post-stats'
export interface PostBatchJob {
  organizationId: string;
  socialAccountId: string;
  pageAccountId?: string;
  platform: Platform; 
  postIds: string[]; 
  batchNumber?: number;
}

// Payload for 'fetch-page-stats'
export interface PageStatsJob {
  organizationId: string;
  socialAccountId?: string;
  platform: Platform;
  targetId: string;
  targetModel: 'PAGE' | 'PROFILE';
}

export interface AnalyticsJob {
  organizationId: string;
  platform: Platform;
  
  // Who is this job for?
  targetId: string;           // The DB ID (either SocialAccount.id or PageAccount.id)
  targetModel: 'PAGE' | 'PROFILE';

  // For Post Analytics
  postIds?: string[];
}