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

    const signatureHeader = req.headers['tiktok-signature'] as string;

    if (!signatureHeader) {
      this.logger.warn(
        'TikTok Webhook failed: Missing tiktok-signature header',
      );
      throw new UnauthorizedException('Missing signature');
    }

    const clientSecret = this.config.get<string>('TIKTOK_CLIENT_SECRET');
    if (!clientSecret) {
      this.logger.error(
        'TIKTOK_CLIENT_SECRET is missing in environment variables.',
      );
      throw new UnauthorizedException('Server configuration error');
    }

    const rawBody = req.rawBody;

    if (!rawBody) {
      this.logger.error(
        'Raw body is missing! Ensure { rawBody: true } is enabled in main.ts.',
      );
      throw new UnauthorizedException('Missing raw body');
    }

    // 2. FIX: Parse the "t=...,s=..." format
    let signature = '';
    let timestamp = '';

    const parts = signatureHeader.split(',');
    for (const part of parts) {
      if (part.startsWith('t=')) timestamp = part.substring(2);
      if (part.startsWith('s=')) signature = part.substring(2);
    }

    if (!signature || !timestamp) {
      this.logger.warn(
        `TikTok Webhook failed: Invalid signature format -> ${signatureHeader}`,
      );
      throw new UnauthorizedException('Invalid signature format');
    }

    // 3. FIX: TikTok requires hashing the timestamp and raw body together
    // Format: timestamp + "." + rawBody
    const stringToSign = `${timestamp}.${rawBody.toString('utf8')}`;

    // 4. Generate the HMAC-SHA256 hash using your TikTok Client Secret
    const expectedSignature = crypto
      .createHmac('sha256', clientSecret)
      .update(stringToSign)
      .digest('hex');

    // 5. Safely compare the two hashes
    if (expectedSignature !== signature) {
      this.logger.warn(
        `TikTok Webhook failed: Signature mismatch. Expected ${expectedSignature}, got ${signature}`,
      );
      throw new UnauthorizedException('Invalid signature');
    }

    this.logger.log('TikTok Webhook Signature Verified Successfully!');
    return true;
  }
}
