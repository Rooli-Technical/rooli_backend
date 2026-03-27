export const PLATFORM_LIMITS = {
  twitter: {
    publish: { limit: 300, window: 60 * 60 * 3 }, // tweets + retweets / 3h
    fetchTweets: { limit: 900, window: 15 * 60 }, // search/list/timeline
  },
  instagram: {
    general: { limit: 200, window: 60 * 60 },
    publish: { limit: 50, window: 60 * 60 },
    dm: { limit: 50, window: 60 * 60 },
    insights: { limit: 50, window: 60 * 60 },
  },
  linkedin: {
    general: { limit: 1000, window: 60 * 60 * 24 },
    publish: { limit: 500, window: 60 * 60 * 24 },
    analytics: { limit: 500, window: 60 * 60 * 24 },
  },
  facebook: {
    general: { limit: 1000, window: 60 * 60 * 24 },
    publish: { limit: 500, window: 60 * 60 * 24 },
    insights: { limit: 500, window: 60 * 60 * 24 },
  },
} as const;
