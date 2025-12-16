export interface PostMetrics {
  likes: number;
  comments: number;
  shares: number;       // Note: IG & LinkedIn often return 0 for this
  impressions: number;  // Views on screen

  reach?: number;       // Unique people (FB/IG)
  clicks?: number;      // Link clicks (LinkedIn/Twitter)
  saves?: number;       // Bookmarks (IG/Twitter)
  video_views?: number; // 3-second views (FB/IG/Twitter)
  
  raw?: Record<string, any>; 
}