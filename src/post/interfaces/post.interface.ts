export interface BulkCsvRow {
  content: string;
  scheduled_at: string;
  profile_ids: string;
  media_url?: string;
  post_id?: string;
}

export interface BulkValidationError {
  row: number;
  message: string;
}

export interface BulkValidationResult {
  validPosts: PreparedPost[];
  errors: BulkValidationError[];
}

export interface PreparedPost {
  content: string;
  scheduledAt: Date | string;
  profileIds: string[];
  mediaUrl?: string;
  postId?: string;
}
