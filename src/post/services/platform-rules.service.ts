import { Platform } from '@generated/enums';
import { Injectable, BadRequestException } from '@nestjs/common';
import * as twitter from 'twitter-text';


export interface ValidationResult {
  isValid: boolean;
  finalContent: string;        // The content for the main post
  threadChain?: string[];      // Extra parts (for Twitter auto-threading)
}
@Injectable()
export class PlatformRulesService {
  private readonly X_CHAR_LIMIT = 280;
  private readonly X_MAX_MEDIA = 4;
  private readonly LINKEDIN_CHAR_LIMIT = 3000;
  private readonly IG_CAPTION_LIMIT = 2200;
  private readonly IG_HASHTAG_LIMIT = 30;

 public validateAndTransform(
    content: string,
    platform: string, // Use string or Enum
    media: any[] = []
  ): ValidationResult {
    switch (platform) {
      case 'TWITTER': return this.processTwitter(content, media);
      case 'LINKEDIN': return this.processLinkedIn(content, media);
      case 'FACEBOOK': return this.processFacebook(content, media);
      case 'INSTAGRAM': return this.processInstagram(content, media);
      default: return { isValid: true, finalContent: content };
    }
  }

 private processTwitter(content: string, media: any[]): ValidationResult {
    if (media.length > 4) throw new BadRequestException('Twitter max 4 images.');

    const parse = twitter.parseTweet(content);
    
    // Case A: Fits in one tweet
    if (parse.valid) {
      return { isValid: true, finalContent: content };
    }

    // Case B: Needs Splitting (Simple logic)
    // NOTE: In production, use a sentence splitter library
    const chunks: string[] = [];
    const words = content.split(' ');
    let buffer = '';

    for (const word of words) {
      const candidate = buffer ? `${buffer} ${word}` : word;
      if (twitter.parseTweet(candidate).valid) {
        buffer = candidate;
      } else {
        chunks.push(buffer);
        buffer = word;
      }
    }
    if (buffer) chunks.push(buffer);

    // Numbering (1/3)
    const total = chunks.length;
    const finalChunks = chunks.map((c, i) => `${c} (${i + 1}/${total})`);

    return {
      isValid: true,
      finalContent: finalChunks[0],      // First Tweet
      threadChain: finalChunks.slice(1), // Remaining Tweets
    };
  }

  private processInstagram(
    content: string,
    media: { width?: number; height?: number }[],
  ) {
    // 1. Content Limits
    if (content.length > this.IG_CAPTION_LIMIT) {
      throw new Error(`Caption exceeds ${this.IG_CAPTION_LIMIT} characters.`);
    }

    // 2. Efficient Hashtag Counting
    // Matches # followed by alphanumeric chars.
    const hashtagCount = (content.match(/#[a-z0-9_]+/gi) || []).length;
    if (hashtagCount > this.IG_HASHTAG_LIMIT) {
      throw new Error(`Max ${this.IG_HASHTAG_LIMIT} hashtags allowed.`);
    }

    // 3. Media Requirements
    if (media.length === 0) {
      throw new Error('Instagram requires at least 1 image or video.');
    }
    if (media.length > 10) {
      throw new Error('Instagram Carousel allows max 10 items.');
    }

    // 4. Aspect Ratio Check (Floating Point Safe)
    for (const m of media) {
      if (!m.width || !m.height) continue; // Skip if metadata missing

      const ratio = m.width / m.height;

      // Instagram Ratios: Square (1:1), Portrait (4:5 -> 0.8), Landscape (1.91:1), Reel (9:16 -> 0.5625)
      // Allow a small epsilon for rounding errors
      const isSquare = Math.abs(ratio - 1) < 0.02;
      const isPortrait = Math.abs(ratio - 0.8) < 0.02;
      const isLandscape = Math.abs(ratio - 1.91) < 0.02;
      const isReel = Math.abs(ratio - 9 / 16) < 0.02;

      if (!isSquare && !isPortrait && !isLandscape && !isReel) {
        throw new Error(
          `Invalid aspect ratio (${ratio.toFixed(2)}). Supported: 1:1, 4:5, 1.91:1, 9:16`,
        );
      }
    }
    return { isValid: true, finalContent: content };
  }

  private processFacebook(content: string, media: any[]) {
    if (media.length > 10) {
      throw new Error('Facebook allows max 10 photos/videos per post.');
    }
    return { isValid: true, finalContent: content };
  }

  private processLinkedIn(content: string, media: any[]) {
    if (content.length > this.LINKEDIN_CHAR_LIMIT) {
      throw new Error(
        `Text exceeds LinkedIn limit (${content.length}/${this.LINKEDIN_CHAR_LIMIT}).`,
      );
    }
    if (media.length > 9) {
      throw new Error('LinkedIn recommends max 9 images.');
    }
      // --- A. VALIDATION: Check counts ---
      const videoCount = media.filter(f => f.mimeType.startsWith('video/')).length;
      const imageCount = media.filter(f => f.mimeType.startsWith('image/')).length;
      const docCount = media.filter(f => f.mimeType === 'application/pdf').length;

      // Rule: Documents must be standalone
      if (docCount > 0 && (videoCount > 0 || imageCount > 0)) {
        throw new BadRequestException('LinkedIn Documents (PDFs) cannot be mixed with images or videos.');
      }
      if (docCount > 1) {
        throw new BadRequestException('LinkedIn allows only 1 Document (PDF) per post.');
      }
      if (videoCount > 1) {
        throw new BadRequestException('LinkedIn allows only 1 Video per post.');
      }
    return { isValid: true, finalContent: content };
  }
}
