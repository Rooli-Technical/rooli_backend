export interface PostResult {
  platformPostId: string; // The ID returned by Twitter/FB
  url?: string;           // Direct link to the post
}

export interface SocialCredentials {
  accessToken: string;
  refreshToken?: string; // Required for Twitter OAuth 1.0a
  accessSecret?: string; // Required for Twitter OAuth 1.0a
}

export interface ISocialProvider {
  publish(
    credentials: SocialCredentials, 
    content: string,
    mediaFiles: { url: string; mimeType: string }[], // Need mimeType for video/images
    metadata?: any
  ): Promise<any>;
}

type MediaFile = { 
  url: string; 
  mimeType: string; 
  // Optional: Only strictly required for Reels
  metadata?: { 
    durationSeconds?: number; 
    width?: number; 
    height?: number; 
  } 
};