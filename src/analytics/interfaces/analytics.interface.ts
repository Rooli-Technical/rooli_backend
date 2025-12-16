import { Platform } from "@generated/enums";
import { PageMetrics } from "./page-metrics.interface";
import { PostMetrics } from "./post-metrics.interface";

export interface PostBatchJob {
  batchNumber: number;
  platform: Platform;
  postIds: string[]; // Platform IDs (external)
  
  // Context: Who owns these posts?
  organizationId: string;
  socialAccountId?: string; // If it's a profile post
  pageAccountId?: string;   // If it's a page post
}

export interface PageStatsJob {
  organizationId: string;
  targetId: string;           // DB ID of SocialAccount OR PageAccount
  targetModel: 'PROFILE' | 'PAGE';
  platform: Platform;
  
  // Helper to find the parent if needed (for LinkedIn)
  socialAccountId?: string; 
}

export interface AuthContext {
  platformAccountId: string;
  accessToken: string;
  tokenSecret?: string;
}

export interface AnalyticsStrategy {
  getMetrics(context: AuthContext, postIds: string[]): Promise<Record<string, PostMetrics>>;
}

export interface PageAnalyticsStrategy {
  getPageStats(context: AuthContext): Promise<PageMetrics>;
}
