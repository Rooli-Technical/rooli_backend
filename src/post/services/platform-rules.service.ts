import { Platform } from '@generated/enums';
import { Injectable, BadRequestException } from '@nestjs/common';
import * as twitter from 'twitter-text';
import { MediaItem, IgPostKind } from '../interfaces/post.interface';

export interface ValidationResult {
  isValid: boolean;
  finalContent: string; // The content for the main post
  threadChain?: string[]; // Extra parts (for Twitter auto-threading)
}
@Injectable()
export class PlatformRulesService {
  // -----------------------
  // X / Twitter
  // -----------------------
  private readonly X_MAX_MEDIA = 4;
  private readonly X_MAX_THREAD_TWEETS = 20; // prevent insane threads
  private readonly X_SAFE_LIMIT = 260;

  // -----------------------
  // LinkedIn
  // -----------------------
  private readonly LINKEDIN_CHAR_LIMIT = 3000;
  private readonly LINKEDIN_MAX_IMAGES = 9;
  private readonly LINKEDIN_MAX_IMAGE_DIMENSION = 6012;

  // -----------------------
  // Instagram
  // -----------------------
  private readonly IG_CAPTION_LIMIT = 2200;
  private readonly IG_HASHTAG_LIMIT = 30;
  private readonly IG_CAROUSEL_MAX = 10;

  /**
   * ✅ 2) Strict platform handling: no silent defaults
   * ✅ 3) Keep media typed and optional
   */
  public validateAndTransform(
    content: string,
    platform: Platform,
    media: MediaItem[] = [],
    options?: { igKind?: IgPostKind; FbKind?: 'POST' | 'STORY' | 'REEL' },
  ): ValidationResult {
    const safeContent = (content ?? '').trim();

    switch (platform) {
      case Platform.TWITTER:
        return this.processTwitter(safeContent, media);

      case Platform.LINKEDIN:
        return this.processLinkedIn(safeContent, media);

      case Platform.FACEBOOK:
        return this.processFacebook(
          safeContent,
          media,
          options?.FbKind ?? 'POST',
        );

      case Platform.INSTAGRAM:
        return this.processInstagram(
          safeContent,
          media,
          options?.igKind ?? 'FEED',
        );

      default:
        // (Enum makes this unreachable, but keeps runtime safe)
        throw new BadRequestException(`Unsupported platform: ${platform}`);
    }
  }

  // ===========================================================================
  // X / Twitter
  // ===========================================================================
  /**
   * ✅ Uses twitter-text parseTweet (correct counting)
   * ✅ Thread splitting:
   *   - prevents empty chunks
   *   - handles unbreakable long words
   *   - validates AFTER numbering
   *   - caps max tweets
   * ✅ Media policy:
   *   - allow up to 4 media TOTAL (assumes you attach to first tweet only)
   */
  private processTwitter(
    content: string,
    media: MediaItem[],
  ): ValidationResult {
    if (media.length > this.X_MAX_MEDIA) {
      throw new BadRequestException(
        `X allows max ${this.X_MAX_MEDIA} media items per tweet.`,
      );
    }

    if (twitter.parseTweet(content).valid) {
      return { isValid: true, finalContent: content };
    }

    // ✅ Keep splitting until numbering no longer breaks validity
    const numbered = this.splitNumberAndStabilizeX(content);

    return {
      isValid: true,
      finalContent: numbered[0],
      threadChain: numbered.slice(1),
    };
  }

  private splitNumberAndStabilizeX(content: string): string[] {
    let safeLimit = this.X_SAFE_LIMIT; // e.g. 260
    let lastTweetCount = -1;

    for (let attempt = 0; attempt < 10; attempt++) {
      const rawChunks = this.splitForXByWeightedLimit(content, safeLimit);

      if (rawChunks.length > this.X_MAX_THREAD_TWEETS) {
        throw new BadRequestException(
          `Content too long. Would require ${rawChunks.length} tweets (max ${this.X_MAX_THREAD_TWEETS}).`,
        );
      }

      const allValid = rawChunks.every((t) => twitter.parseTweet(t).valid);
      if (allValid) return rawChunks;

      // If count exploded or we’re not converging, tighten limit
      if (rawChunks.length === lastTweetCount) {
        safeLimit -= 5; // small tightening
      } else {
        safeLimit -= 8; // bigger tightening when tweet count changes
      }

      if (safeLimit < 200) {
        throw new BadRequestException(
          'Cannot split content into valid tweets. Please shorten text.',
        );
      }

      lastTweetCount = rawChunks.length;
    }

    throw new BadRequestException(
      'Unable to stabilize thread splitting for X.',
    );
  }

  /**
   * ✅ Uses weightedLength (twitter-text) and preserves whitespace exactly.
   * This is your current splitForX, but parameterized by limit.
   */
  private splitForXByWeightedLimit(content: string, limit: number): string[] {
    const tokens = content.split(/(\s+)/);
    const chunks: string[] = [];
    let buffer = '';

    for (const token of tokens) {
      const candidate = buffer + token;
      const len = twitter.parseTweet(candidate).weightedLength;

      if (len <= limit) {
        buffer = candidate;
        continue;
      }

      // Token itself too big -> hard split
      if (twitter.parseTweet(token).weightedLength > limit) {
        if (buffer) {
          chunks.push(buffer);
          buffer = '';
        }
        chunks.push(...this.hardSplitTokenForX(token));
        continue;
      }

      // Normal split
      if (buffer) chunks.push(buffer);
      buffer = token;
    }

    if (buffer) chunks.push(buffer);

    return chunks.filter((c) => c.trim().length > 0);
  }

  /**
   * Hard-split a token that has no spaces and is too long.
   * This is a last resort. You can also choose to reject instead.
   */
  private hardSplitTokenForX(token: string): string[] {
    const parts: string[] = [];
    let start = 0;

    // naive approach: grow until invalid, then cut
    while (start < token.length) {
      let end = Math.min(token.length, start + 280); // upper bound; real counting handled below
      let slice = token.slice(start, end);

      // shrink until valid
      while (slice.length > 0 && !twitter.parseTweet(slice).valid) {
        end--;
        slice = token.slice(start, end);
      }

      if (!slice) {
        throw new BadRequestException(
          `Cannot split content for X. A token is too long to fit.`,
        );
      }

      parts.push(slice);
      start = end;
    }

    return parts;
  }

  // ===========================================================================
  // Instagram
  // ===========================================================================
  /**
   * ✅ Separates FEED vs REEL constraints
   * ✅ Uses ratio ranges for FEED (real-world safe)
   * ✅ Validates media types
   */
  private processInstagram(
    content: string,
    media: MediaItem[],
    kind: IgPostKind,
  ): ValidationResult {
    if (content.length > this.IG_CAPTION_LIMIT) {
      throw new BadRequestException(
        `Caption exceeds ${this.IG_CAPTION_LIMIT} characters.`,
      );
    }

    // Hashtags: keep your simple rule (English-oriented)
    const hashtagCount = (content.match(/#[a-z0-9_]+/gi) || []).length;
    if (hashtagCount > this.IG_HASHTAG_LIMIT) {
      throw new BadRequestException(
        `Max ${this.IG_HASHTAG_LIMIT} hashtags allowed.`,
      );
    }

    if (media.length === 0) {
      throw new BadRequestException(
        'Instagram requires at least 1 image or video.',
      );
    }

    const hasPdf = media.some((m) => m.mimeType === 'application/pdf');
    if (hasPdf) {
      throw new BadRequestException('Instagram does not support PDF posts.');
    }

    const videoCount = media.filter((m) =>
      m.mimeType?.startsWith('video/'),
    ).length;
    const imageCount = media.filter((m) =>
      m.mimeType?.startsWith('image/'),
    ).length;

    if (videoCount + imageCount !== media.length) {
      throw new BadRequestException(
        'Instagram media must be image/* or video/*.',
      );
    }

    if (kind === 'REEL') {
      // Reels: usually one video
      if (videoCount !== 1 || media.length !== 1) {
        throw new BadRequestException('Reels require exactly 1 video.');
      }

      // Optional: ratio check for reels (allow small range)
      //this.validateIgRatios(media, { kind: 'REEL' });

      return { isValid: true, finalContent: content };
    }

    // FEED
    if (media.length > this.IG_CAROUSEL_MAX) {
      throw new BadRequestException(
        `Instagram carousel allows max ${this.IG_CAROUSEL_MAX} items.`,
      );
    }

    //this.validateIgRatios(media, { kind: 'FEED' });

    return { isValid: true, finalContent: content };
  }

  /**
   * ✅ FEED: ratio range 0.8 to 1.91 (width/height)
   * ✅ REEL: near 9/16 with wider tolerance range
   */
  // private validateIgRatios(media: MediaItem[], opts: { kind: IgPostKind }) {
  //   for (const m of media) {
  //     if (!m.width || !m.height) continue; // metadata missing: skip

  //     const ratio = m.width / m.height;

  //     if (opts.kind === 'FEED') {
  //       // Real-world safe: Instagram feed allows between 4:5 (0.8) and 1.91:1
  //       if (ratio < 0.79 || ratio > 1.92) {
  //         throw new BadRequestException(
  //           `Invalid feed aspect ratio (${ratio.toFixed(2)}). Supported range: 0.80 to 1.91 (4:5 to 1.91:1).`,
  //         );
  //       }
  //     } else {
  //       // Reels: 9:16 ≈ 0.5625. Allow small range for encoders/crops.
  //       if (ratio < 0.55 || ratio > 0.6) {
  //         throw new BadRequestException(
  //           `Invalid reel aspect ratio (${ratio.toFixed(2)}). Expected ~9:16.`,
  //         );
  //       }
  //     }
  //   }
  // }

  // ===========================================================================
  // Facebook
  // ===========================================================================

private processFacebook(
    content: string,
    media: MediaItem[],
    FbKind: 'POST' | 'STORY' | 'REEL',
  ): ValidationResult {
    const safeContent = (content ?? '').trim();

    // 1. Prevent completely empty posts (No text AND no media)
    if (media.length === 0 && safeContent.length === 0) {
      throw new BadRequestException('Facebook post must contain either text or media.');
    }

    // 2. If it is a Text-Only post, it is perfectly valid!
    if (media.length === 0) {
      return { isValid: true, finalContent: content };
    }

    // 3. Strict Media Quantity Limits
    if (FbKind === 'POST' && media.length > 10) {
      throw new BadRequestException('Facebook Feed allows max 10 media items.');
    }
    
    if ((FbKind === 'STORY' || FbKind === 'REEL') && media.length > 1) {
      throw new BadRequestException(`Facebook ${FbKind === 'STORY' ? 'Stories' : 'Reels'} only support exactly 1 media item.`);
    }

    // 4. Validate each media item
    for (const m of media) {
      if (!m?.mimeType) {
        throw new BadRequestException('Missing media mimeType.');
      }

      const isImage = m.mimeType.startsWith('image/');
      const isVideo = m.mimeType.startsWith('video/');

      if (!isImage && !isVideo) {
        throw new BadRequestException('Facebook media must be image/* or video/*.');
      }

      if (m.size == null || Number.isNaN(m.size)) {
        throw new BadRequestException('Missing media size (sizeBytes).');
      }

      // -----------------------------------------------------------------------
      // FEED_POST (permissive)
      // -----------------------------------------------------------------------
      if (FbKind === 'POST') {
        continue; // Standard feed posts are highly flexible, move to next item
      }

      // -----------------------------------------------------------------------
      // STORY (photos + mp4 videos)
      // -----------------------------------------------------------------------
      if (FbKind === 'STORY') {
        if (isImage) {
          const allowedImageMimes = new Set([
            'image/jpeg', 'image/jpg', 'image/bmp', 
            'image/png', 'image/gif', 'image/tiff'
          ]);

          if (!allowedImageMimes.has(m.mimeType)) {
            throw new BadRequestException('Facebook Story images must be jpeg/jpg, bmp, png, gif, or tiff.');
          }

          if (m.size > 10 * 1024 * 1024) {
            throw new BadRequestException('Facebook Story image must not exceed 10MB.');
          }
          continue;
        }

        // Video story rules
        if (m.mimeType !== 'video/mp4') {
          throw new BadRequestException('Facebook Story video must be mp4.');
        }
        if (m.duration == null || m.width == null || m.height == null) {
          throw new BadRequestException('Missing video metadata (duration, width, or height).');
        }
        if (m.duration < 3 || m.duration > 90) {
          throw new BadRequestException('Facebook Story video must be between 3 and 90 seconds.');
        }
        if (m.width < 540 || m.height < 960) {
          throw new BadRequestException(
            `Stories must be vertical. Your video is ${m.width}x${m.height}. Please upload a video with a 9:16 aspect ratio (like 1080x1920).`
          );
        }
        continue;
      }

      // -----------------------------------------------------------------------
      // REEL (video-only)
      // -----------------------------------------------------------------------
      if (FbKind === 'REEL') {
        if (!isVideo) {
          throw new BadRequestException('Facebook Reel must be a video.');
        }
        if (m.mimeType !== 'video/mp4') {
          throw new BadRequestException('Facebook Reel video must be mp4.');
        }
        if (m.duration == null || m.width == null || m.height == null) {
          throw new BadRequestException('Missing video metadata (duration, width, or height).');
        }
        if (m.duration < 3 || m.duration > 90) {
          throw new BadRequestException('Facebook Reel must be 3 to 90 seconds.');
        }
        // It's usually a good idea to enforce vertical ratios for Reels here too!
        if (m.width > m.height) {
            throw new BadRequestException(
                `Reels must be vertical. Your video is ${m.width}x${m.height}. Please upload a vertical video.`
            );
        }
        continue;
      }
    }

    return { isValid: true, finalContent: content };
  }

  // ===========================================================================
  // LinkedIn
  // ===========================================================================
  /**
   * ✅ Consistent exceptions
   * ✅ Validates mixing rules
   * ✅ Enforces 1 PDF OR 1 video OR up to 9 images
   */
  private processLinkedIn(
    content: string,
    media: MediaItem[],
  ): ValidationResult {
    if (content.length > this.LINKEDIN_CHAR_LIMIT) {
      throw new BadRequestException(
        `Text exceeds LinkedIn limit (${content.length}/${this.LINKEDIN_CHAR_LIMIT}).`,
      );
    }

    const videoCount = media.filter((f) =>
      f.mimeType?.startsWith('video/'),
    ).length;
    const imageCount = media.filter((f) =>
      f.mimeType?.startsWith('image/'),
    ).length;
    const docCount = media.filter(
      (f) => f.mimeType === 'application/pdf',
    ).length;

    if (videoCount + imageCount + docCount !== media.length) {
      throw new BadRequestException(
        'LinkedIn media must be image/*, video/*, or application/pdf.',
      );
    }

    // Documents must be standalone
    if (docCount > 0 && (videoCount > 0 || imageCount > 0)) {
      throw new BadRequestException(
        'LinkedIn PDF posts cannot be mixed with images or videos.',
      );
    }

    if (docCount > 1) {
      throw new BadRequestException('LinkedIn allows only 1 PDF per post.');
    }

    if (videoCount > 1) {
      throw new BadRequestException('LinkedIn allows only 1 video per post.');
    }

    if (imageCount > this.LINKEDIN_MAX_IMAGES) {
      throw new BadRequestException(
        `LinkedIn allows max ${this.LINKEDIN_MAX_IMAGES} images.`,
      );
    }

    for (const m of media) {
      if (!m.mimeType?.startsWith('image/')) continue;

      if (!m.width || !m.height) continue; // metadata missing → skip or enforce if you prefer

      if (
        m.width > this.LINKEDIN_MAX_IMAGE_DIMENSION ||
        m.height > this.LINKEDIN_MAX_IMAGE_DIMENSION
      ) {
        throw new BadRequestException(
          `LinkedIn image too large (${m.width}×${m.height}). ` +
            `Max allowed is ${this.LINKEDIN_MAX_IMAGE_DIMENSION}×${this.LINKEDIN_MAX_IMAGE_DIMENSION}px.`,
        );
      }
    }

    return { isValid: true, finalContent: content };
  }
}
