import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';

@Injectable()
export class ScraperService {
  async scrapeUrl(url: string): Promise<string> {
    // 1. Parse + validate URL
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch {
      throw new BadRequestException(
        'Invalid URL. Please provide a valid http/https link.',
      );
    }

    // 2. SSRF PROTECTION — block private IP ranges
    const hostname = parsed.hostname.toLowerCase();
    const blockedPatterns = [
      /^localhost$/,
      /^127\./,
      /^10\./,
      /^192\.168\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^169\.254\./, // link-local / AWS metadata
      /^::1$/, // IPv6 localhost
      /^fc00:/, // IPv6 private
      /^fe80:/, // IPv6 link-local
    ];

    if (blockedPatterns.some((p) => p.test(hostname))) {
      throw new BadRequestException('This URL cannot be scraped.');
    }

    // 3. Fetch the page
    try {
      const res = await axios.get<string>(parsed.toString(), {
        headers: {
          'User-Agent': 'RooliBot/1.0 (+https://rooli.app)',
          Accept: 'text/html,application/xhtml+xml',
        },
        timeout: 8000,
        maxRedirects: 5,
        maxContentLength: 2_000_000,
        validateStatus: () => true,
      });

      // 4. Content-type check — must be HTML
      const contentType = String(res.headers['content-type'] ?? '');
      if (
        !contentType.includes('text/html') &&
        !contentType.includes('application/xhtml')
      ) {
        throw new BadRequestException(
          'URL must point to an HTML page (got ' + contentType + ').',
        );
      }

      // 5. Status code handling
      if (res.status === 429) {
        throw new ServiceUnavailableException(
          'This website is rate-limiting requests. Try again later.',
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new ForbiddenException(
          'This website blocked access. Try a different link or paste text instead.',
        );
      }
      if (res.status >= 500) {
        throw new ServiceUnavailableException(
          'The website is currently unavailable. Try again later.',
        );
      }
      if (res.status >= 400) {
        throw new BadRequestException(
          `Failed to fetch the URL (HTTP ${res.status}).`,
        );
      }

      // 6. Extract content
      const $ = cheerio.load(res.data);
      $('script, style, nav, footer, header, noscript, iframe').remove();

      let content = '';
      const selectors = [
        'article',
        'main',
        '.post-content',
        '.entry-content',
        '#content',
      ];

      for (const selector of selectors) {
        const found = $(selector).text().trim();
        if (found.length > 200) {
          content = found;
          break;
        }
      }

      if (!content) {
        content = $('p')
          .map((_, el) => $(el).text())
          .get()
          .join('\n')
          .trim();
      }

      const clean = content.replace(/\s+/g, ' ').trim().slice(0, 6000);

      if (clean.length < 100) {
        throw new BadRequestException(
          'Could not extract enough readable content from the provided URL.',
        );
      }

      return clean;
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          throw new ServiceUnavailableException(
            'The website took too long to respond. Try again.',
          );
        }
        throw new ServiceUnavailableException(
          `Failed to fetch the website: ${error.message}`,
        );
      }

      throw new InternalServerErrorException(
        'Unexpected error while processing the URL.',
      );
    }
  }
}
