export interface PageMetrics {
  followers: number;
  following: number;
  postCount: number;

  pageImpressions?: number;   // Total views of the profile/page
  profileViews?: number;      // Specific visits to the profile URL
  websiteClicks?: number;     // Clicks on the bio link
  engagement?: number;        // Total engagements (likes, comments, shares)
}