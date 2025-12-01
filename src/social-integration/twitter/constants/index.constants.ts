
export const TWITTER_CONSTANTS = {
  API_BASE_URL: 'https://api.x.com/2', 
  SCOPES: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'],
  OAUTH_STATE_MAX_AGE_MS: 10 * 60 * 1000,
};



export interface TwitterProfile {
  id: string;
  name: string;
  username: string;
  profileImageUrl?: string;
  description?: string;
  verified?: boolean;
  followersCount?: number;
  followingCount?: number;
  tweetCount?: number;
  listedCount?: number;
  likeCount?: number;
  mediaCount?: number;
  location?: string;
  createdAt?: string;

}
