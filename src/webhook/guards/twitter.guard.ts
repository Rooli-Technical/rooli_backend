// src/webhooks/guards/twitter-webhook.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as crypto from 'crypto';

/**
 * X/Twitter Account Activity API webhook verification:
 * 1) GET "CRC" challenge: respond with { response_token: "sha256=..." }
 * 2) POST signature: verify x-twitter-webhooks-signature = base64(HMAC_SHA256(rawBody, consumerSecret))
 *
 * REQUIREMENT: rawBody must be captured (see main.ts snippet at bottom).
 */
@Injectable()
export class TwitterWebhookGuard implements CanActivate {
  private readonly logger = new Logger(TwitterWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // Allow CRC GET through; controller handles it.
    if (req.method === 'GET') return true;

    const consumerSecret = this.config.get<string>('TWITTER_CONSUMER_SECRET');
    if (!consumerSecret) {
      this.logger.error('TWITTER_CONSUMER_SECRET is not set');
      throw new UnauthorizedException('Webhook signature verification misconfigured');
    }

    const sigHeader = this.getSignature(req);
    if (!sigHeader) throw new UnauthorizedException('Missing Twitter webhook signature');

    const raw = (req as any).rawBody as Buffer | undefined;
    if (!raw || !Buffer.isBuffer(raw)) {
      this.logger.error('rawBody not found on request. Ensure body parser captures rawBody.');
      throw new UnauthorizedException('Webhook signature verification unavailable');
    }

    // header is base64(HMAC_SHA256(rawBody, consumerSecret))
    const expected = crypto.createHmac('sha256', consumerSecret).update(raw).digest('base64');

    const ok = this.timingSafeEqualBase64(sigHeader, expected);
    if (!ok) {
      this.logger.warn(`Twitter signature mismatch.`);
      throw new UnauthorizedException('Invalid Twitter webhook signature');
    }
    return true;
  }

private getSignature(req: Request): string | null {
    const header =
      (req.headers['x-twitter-webhooks-signature'] as string | undefined) ??
      (req.headers['X-Twitter-Webhooks-Signature'] as string | undefined);

    if (!header) return null;

    // Twitter format: "sha256=<base64>"
    const [algo, base64Sig] = header.split('=');
    if (algo !== 'sha256' || !base64Sig) return null;

    return base64Sig.trim();
  }

  private timingSafeEqualBase64(a: string, b: string): boolean {
    // Both are base64 strings; compare decoded buffers
    const ab = Buffer.from(a, 'base64');
    const bb = Buffer.from(b, 'base64');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }
}
