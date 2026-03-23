import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class TikTokWebhookGuard implements CanActivate {
  private readonly logger = new Logger(TikTokWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    
    // TikTok sends the signature in this exact header
    const signature = req.headers['x-tiktok-signature'];

    if (!signature) {
      this.logger.warn('TikTok Webhook failed: Missing X-Tiktok-Signature header');
      throw new UnauthorizedException('Missing signature');
    }

    const clientSecret = this.config.get<string>('TIKTOK_CLIENT_SECRET');
    if (!clientSecret) {
      this.logger.error('TIKTOK_CLIENT_SECRET is missing in environment variables.');
      throw new UnauthorizedException('Server configuration error');
    }

    // 🚨 CRITICAL: You must use the RAW body buffer, not the parsed JSON object!
    // NestJS attaches this to req.rawBody if configured correctly in main.ts
    const rawBody = req.rawBody; 

    if (!rawBody) {
      this.logger.error(
        'Raw body is missing! You must enable { rawBody: true } in your NestJS app configuration.',
      );
      throw new UnauthorizedException('Missing raw body');
    }

    // 1. Generate the HMAC-SHA256 hash using your TikTok Client Secret
    const expectedSignature = crypto
      .createHmac('sha256', clientSecret)
      .update(rawBody)
      .digest('hex');

    // 2. Safely compare the two hashes (prevents timing attacks)
    const isAuthentic = crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature as string),
    );

    if (!isAuthentic) {
      this.logger.warn(
        `TikTok Webhook failed: Signature mismatch. Expected ${expectedSignature}, got ${signature}`,
      );
      throw new UnauthorizedException('Invalid signature');
    }

    return true;
  }
}