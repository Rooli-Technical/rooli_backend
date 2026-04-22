import { BadRequestException } from '@nestjs/common';
import { Platform } from '@generated/enums';
import { PlatformRulesService } from './platform-rules.service';
import { MediaItem } from '../interfaces/post.interface';

const img = (over: Partial<MediaItem> = {}): MediaItem => ({
  mimeType: 'image/jpeg',
  width: 1080,
  height: 1080,
  size: 500_000,
  ...over,
});

const video = (over: Partial<MediaItem> = {}): MediaItem => ({
  mimeType: 'video/mp4',
  width: 1080,
  height: 1920,
  size: 5_000_000,
  duration: 30,
  ...over,
});

const pdf = (over: Partial<MediaItem> = {}): MediaItem => ({
  mimeType: 'application/pdf',
  size: 1_000_000,
  ...over,
});

describe('PlatformRulesService', () => {
  let service: PlatformRulesService;

  beforeEach(() => {
    service = new PlatformRulesService();
  });

  describe('validateAndTransform - dispatch', () => {
    it('throws for unsupported platform', () => {
      expect(() =>
        service.validateAndTransform('hi', 'WHATSAPP' as any, []),
      ).toThrow(BadRequestException);
    });
  });

  describe('Twitter', () => {
    it('returns content as-is when tweet fits the 280 weighted limit', () => {
      const result = service.validateAndTransform(
        'short tweet',
        Platform.TWITTER,
        [],
      );
      expect(result.isValid).toBe(true);
      expect(result.finalContent).toBe('short tweet');
      expect(result.threadChain).toBeUndefined();
    });

    it('auto-splits long content into a thread', () => {
      const content = 'word '.repeat(120).trim(); // ~600 chars, must thread
      const result = service.validateAndTransform(
        content,
        Platform.TWITTER,
        [],
      );
      expect(result.isValid).toBe(true);
      expect(result.threadChain!.length).toBeGreaterThan(0);
      // All chunks — including the finalContent — must be valid tweets
      const twitter = require('twitter-text');
      expect(twitter.parseTweet(result.finalContent).valid).toBe(true);
      for (const chunk of result.threadChain!) {
        expect(twitter.parseTweet(chunk).valid).toBe(true);
      }
    });

    it('rejects > 4 media items', () => {
      expect(() =>
        service.validateAndTransform('hi', Platform.TWITTER, [
          img(),
          img(),
          img(),
          img(),
          img(),
        ]),
      ).toThrow(/max 4 media/i);
    });

    it('rejects content that would require more than the max thread count', () => {
      // >20 tweets worth of characters → exceeds X_MAX_THREAD_TWEETS
      const hugeToken = 'x'.repeat(8000);
      expect(() =>
        service.validateAndTransform(hugeToken, Platform.TWITTER, []),
      ).toThrow(BadRequestException);
    });
  });

  describe('LinkedIn', () => {
    it('accepts normal text posts', () => {
      const result = service.validateAndTransform(
        'Hello LinkedIn',
        Platform.LINKEDIN,
        [],
      );
      expect(result.isValid).toBe(true);
      expect(result.finalContent).toBe('Hello LinkedIn');
    });

    it('rejects when text exceeds 3000 chars', () => {
      expect(() =>
        service.validateAndTransform(
          'a'.repeat(3001),
          Platform.LINKEDIN,
          [],
        ),
      ).toThrow(/exceeds LinkedIn limit/);
    });

    it('rejects mixing PDF with images', () => {
      expect(() =>
        service.validateAndTransform('post', Platform.LINKEDIN, [pdf(), img()]),
      ).toThrow(/cannot be mixed/);
    });

    it('rejects > 9 images', () => {
      const many = Array.from({ length: 10 }, () => img());
      expect(() =>
        service.validateAndTransform('post', Platform.LINKEDIN, many),
      ).toThrow(/max 9 images/);
    });

    it('rejects > 1 video', () => {
      expect(() =>
        service.validateAndTransform('post', Platform.LINKEDIN, [
          video(),
          video(),
        ]),
      ).toThrow(/only 1 video/);
    });

    it('rejects images with pixel dimensions over the limit', () => {
      expect(() =>
        service.validateAndTransform('post', Platform.LINKEDIN, [
          img({ width: 7000, height: 3000 }),
        ]),
      ).toThrow(/image too large/i);
    });

    it('rejects unsupported media mime types', () => {
      expect(() =>
        service.validateAndTransform('post', Platform.LINKEDIN, [
          { mimeType: 'audio/mp3', size: 1000 } as MediaItem,
        ]),
      ).toThrow(/image\/\*, video\/\*, or application\/pdf/);
    });
  });

  describe('Instagram', () => {
    it('rejects post with no media (FEED requires media)', () => {
      expect(() =>
        service.validateAndTransform('caption', Platform.INSTAGRAM, []),
      ).toThrow(/at least 1 image or video/);
    });

    it('rejects captions over 2200 chars', () => {
      expect(() =>
        service.validateAndTransform(
          'a'.repeat(2201),
          Platform.INSTAGRAM,
          [img()],
        ),
      ).toThrow(/Caption exceeds/);
    });

    it('rejects > 30 hashtags', () => {
      const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
      expect(() =>
        service.validateAndTransform(caption, Platform.INSTAGRAM, [img()]),
      ).toThrow(/Max 30 hashtags/);
    });

    it('rejects PDFs', () => {
      expect(() =>
        service.validateAndTransform('caption', Platform.INSTAGRAM, [pdf()]),
      ).toThrow(/does not support PDF/);
    });

    it('rejects > 10 items in a FEED carousel', () => {
      const many = Array.from({ length: 11 }, () => img());
      expect(() =>
        service.validateAndTransform('caption', Platform.INSTAGRAM, many, {
          igKind: 'FEED',
        }),
      ).toThrow(/max 10 items/);
    });

    it('REEL requires exactly 1 video', () => {
      expect(() =>
        service.validateAndTransform('reel', Platform.INSTAGRAM, [img()], {
          igKind: 'REEL',
        }),
      ).toThrow(/exactly 1 video/);
    });

    it('REEL with one video passes', () => {
      const result = service.validateAndTransform(
        'reel',
        Platform.INSTAGRAM,
        [video()],
        { igKind: 'REEL' },
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('Facebook', () => {
    it('rejects completely empty posts', () => {
      expect(() =>
        service.validateAndTransform('', Platform.FACEBOOK, []),
      ).toThrow(/must contain either text or media/);
    });

    it('allows text-only feed posts', () => {
      const result = service.validateAndTransform(
        'just text',
        Platform.FACEBOOK,
        [],
      );
      expect(result.isValid).toBe(true);
    });

    it('rejects FEED with > 10 media', () => {
      const many = Array.from({ length: 11 }, () => img());
      expect(() =>
        service.validateAndTransform('post', Platform.FACEBOOK, many, {
          FbKind: 'POST',
        }),
      ).toThrow(/max 10 media/);
    });

    it('rejects STORY with > 1 media', () => {
      expect(() =>
        service.validateAndTransform('s', Platform.FACEBOOK, [img(), img()], {
          FbKind: 'STORY',
        }),
      ).toThrow(/only support exactly 1 media/);
    });

    it('rejects STORY images above 10MB', () => {
      expect(() =>
        service.validateAndTransform(
          's',
          Platform.FACEBOOK,
          [img({ size: 11 * 1024 * 1024 })],
          { FbKind: 'STORY' },
        ),
      ).toThrow(/must not exceed 10MB/);
    });

    it('rejects STORY videos that are not mp4', () => {
      expect(() =>
        service.validateAndTransform(
          's',
          Platform.FACEBOOK,
          [video({ mimeType: 'video/mov' })],
          { FbKind: 'STORY' },
        ),
      ).toThrow(/must be mp4/);
    });

    it('rejects STORY videos shorter than 3 seconds', () => {
      expect(() =>
        service.validateAndTransform(
          's',
          Platform.FACEBOOK,
          [video({ duration: 2 })],
          { FbKind: 'STORY' },
        ),
      ).toThrow(/between 3 and 90 seconds/);
    });

    it('rejects STORY videos with dimensions below the vertical minimum', () => {
      // code enforces width >= 540 && height >= 960; 1920x800 fails on height
      expect(() =>
        service.validateAndTransform(
          's',
          Platform.FACEBOOK,
          [video({ width: 1920, height: 800 })],
          { FbKind: 'STORY' },
        ),
      ).toThrow(/must be vertical/);
    });

    it('REEL requires video, not image', () => {
      expect(() =>
        service.validateAndTransform('r', Platform.FACEBOOK, [img()], {
          FbKind: 'REEL',
        }),
      ).toThrow(/must be a video/);
    });

    it('REEL must be vertical', () => {
      expect(() =>
        service.validateAndTransform(
          'r',
          Platform.FACEBOOK,
          [video({ width: 1920, height: 1080 })],
          { FbKind: 'REEL' },
        ),
      ).toThrow(/must be vertical/);
    });
  });

  describe('TikTok', () => {
    it('rejects empty media', () => {
      expect(() =>
        service.validateAndTransform('hi', Platform.TIKTOK, []),
      ).toThrow(/at least 1 video or 1 image/);
    });

    it('rejects caption over 4000 chars', () => {
      expect(() =>
        service.validateAndTransform('x'.repeat(4001), Platform.TIKTOK, [
          video(),
        ]),
      ).toThrow(/exceeds the 4000 character limit/);
    });

    it('rejects mixing videos and images', () => {
      expect(() =>
        service.validateAndTransform('hi', Platform.TIKTOK, [video(), img({ mimeType: 'image/jpeg' })]),
      ).toThrow(/cannot mix videos and images/);
    });

    it('rejects videos longer than 10 minutes', () => {
      expect(() =>
        service.validateAndTransform('hi', Platform.TIKTOK, [
          video({ duration: 601 }),
        ]),
      ).toThrow(/cannot exceed/);
    });

    it('rejects videos shorter than 3 seconds', () => {
      expect(() =>
        service.validateAndTransform('hi', Platform.TIKTOK, [
          video({ duration: 2 }),
        ]),
      ).toThrow(/at least 3 seconds/);
    });

    it('rejects > 1 video', () => {
      expect(() =>
        service.validateAndTransform('hi', Platform.TIKTOK, [video(), video()]),
      ).toThrow(/maximum of 1 video/);
    });

    it('Photo Mode requires at least 2 images', () => {
      expect(() =>
        service.validateAndTransform('hi', Platform.TIKTOK, [
          img({ mimeType: 'image/jpeg' }),
        ]),
      ).toThrow(/at least 2 images/);
    });

    it('Photo Mode rejects PNG images', () => {
      expect(() =>
        service.validateAndTransform('hi', Platform.TIKTOK, [
          img({ mimeType: 'image/png' }),
          img({ mimeType: 'image/png' }),
        ]),
      ).toThrow(/does not support image\/png/);
    });

    it('Photo Mode rejects > 35 images', () => {
      const many = Array.from({ length: 36 }, () => img({ mimeType: 'image/jpeg' }));
      expect(() =>
        service.validateAndTransform('hi', Platform.TIKTOK, many),
      ).toThrow(/maximum of 35 images/);
    });

    it('Photo Mode rejects images over 20MB', () => {
      expect(() =>
        service.validateAndTransform('hi', Platform.TIKTOK, [
          img({ mimeType: 'image/jpeg', size: 20 * 1024 * 1024 + 1 }),
          img({ mimeType: 'image/jpeg' }),
        ]),
      ).toThrow(/20MB or smaller/);
    });

    it('accepts a valid video', () => {
      const result = service.validateAndTransform('hi', Platform.TIKTOK, [
        video({ duration: 30 }),
      ]);
      expect(result.isValid).toBe(true);
    });
  });
});
