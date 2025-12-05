import { Platform, PostStatus, ScheduleJobStatus } from "@generated/enums";

export interface SocialPlatform {
  schedulePost(post: ScheduledPost): Promise<PublishingResult>;
  publishImmediately(post: ScheduledPost): Promise<PublishingResult>;
  deleteScheduledPost(postId: string, accessToken: string): Promise<boolean>;
  validateCredentials(accessToken: string): Promise<boolean>;
}

export interface BaseScheduledPost {
  id: string;
  content: string;
  mediaUrls: string[];
  scheduledAt: Date;
  timezone?: string;
}

export interface MetaScheduledPost extends BaseScheduledPost {
  platform: Platform;
  accessToken: string;
  pageId?: string;
  pageAccountId?: string;
  platformAccountId?: string;
  instagramBusinessId?: string;
  containerId?: string;
  contentType?: string;
  metadata: any;
}

export type ScheduledPost =
  | MetaScheduledPost
  | TwitterScheduledPost
  | LinkedInScheduledPost;

export interface TwitterScheduledPost extends BaseScheduledPost {
  platform: Platform;
  accessToken: string;
  accountId: string;
  threadItems?: ThreadItem[];
}

export interface ThreadItem {
  content: string;
  mediaUrls: string[];
}

export interface LinkedInScheduledPost extends BaseScheduledPost {
  platform: Platform;
  accessToken: string;
  accountId: string;
  authorUrn?: string;
  visibility?: string;
}

export interface InstagramPublishingResult {
  success: boolean;
  platformPostId?: string;
  publishedAt?: Date;
  error?: string;
  containerId?: string;
  childContainerIds?: string[];
  itemCount?: number;
  mediaType?: string;
  containerStatus?: string;
}

export interface PlatformServiceMap {
  [key: string]: any;
}

export interface PostMetadata {
  accessToken: string;
  pageId?: string;
  platformAccountId?: string;
  instagramBusinessId?: string;
  pageAccountId?: string;
}

export interface PublishingResult {
  success: boolean;
  platformPostId?: string;
  publishedAt?: Date;
  metadata?: any;
  error?: string;
}

export interface ScheduledJobData {
  postId: string;
  socialAccountId: string;
  platform: Platform;
  scheduledAt: Date;
  pageAccountId?: string;
  retryCount?: number;
}

export interface FacebookPostParams {
  message?: string;
  link?: string;
  scheduled_publish_time?: number;
  published?: boolean;
  access_token: string;
}

export interface InstagramPostParams {
  caption?: string;
  mediaType: 'IMAGE' | 'CAROUSEL' | 'VIDEO' | 'REEL';
  children?: string[];
  access_token: string;
}

export interface TwitterPostParams {
  text: string;
  media?: { media_ids: string[] };
}

export interface LinkedInPostParams {
  author: string;
  commentary: string;
  visibility: 'PUBLIC' | 'CONNECTIONS';
  distribution?: {
    feedDistribution: 'MAIN_FEED' | 'NONE';
  };
}

export interface ScheduleResult {
  success: boolean;
  jobId?: string;
  error?: string;
  message?: string;
}

export interface CancelResult {
  success: boolean;
  error?: string;
  message?: string;
}

export interface UpdatePostStatus {
  postId: string;
  status: PostStatus;
  queueStatus: ScheduleJobStatus; 
  metadata?: Record<string, any>;
}

export interface UpdatePublishPost{
  publishedAt
}
