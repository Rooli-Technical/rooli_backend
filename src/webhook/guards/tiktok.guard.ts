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

  // Set your tolerance window (e.g., 5 minutes = 300 seconds)
  private readonly TIMESTAMP_TOLERANCE_SECONDS = 300; 

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();

    const signatureHeader = req.headers['tiktok-signature'] as string;

    if (!signatureHeader) {
      this.logger.warn('TikTok Webhook failed: Missing tiktok-signature header');
      throw new UnauthorizedException('Missing signature');
    }

    const clientSecret = this.config.get<string>('TIKTOK_CLIENT_SECRET');
    if (!clientSecret) {
      this.logger.error('TIKTOK_CLIENT_SECRET is missing in environment variables.');
      throw new UnauthorizedException('Server configuration error');
    }

    const rawBody = req.rawBody;

    if (!rawBody) {
      this.logger.error('Raw body is missing! Ensure { rawBody: true } is enabled in main.ts.');
      throw new UnauthorizedException('Missing raw body');
    }

    let signature = '';
    let timestamp = '';

    const parts = signatureHeader.split(',');
    for (let part of parts) {
      // FIX: Added .trim() to handle potential spaces like 't=..., s=...'
      part = part.trim(); 
      if (part.startsWith('t=')) timestamp = part.substring(2);
      if (part.startsWith('s=')) signature = part.substring(2);
    }

    if (!signature || !timestamp) {
      throw new UnauthorizedException('Invalid signature format');
    }

    // FIX: Add Timestamp Tolerance Check (Replay Attack Prevention)
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const receivedTimestamp = parseInt(timestamp, 10);
    
    if (Math.abs(currentTimestamp - receivedTimestamp) > this.TIMESTAMP_TOLERANCE_SECONDS) {
      this.logger.warn(`Webhook timestamp is too old or too far in the future. Received: ${receivedTimestamp}, Current: ${currentTimestamp}`);
      throw new UnauthorizedException('Timestamp validation failed (possible replay attack)');
    }

    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const timestampBuffer = Buffer.from(`${timestamp}.`, 'utf8');
    
    const stringToSignBuffer = Buffer.concat([timestampBuffer, bodyBuffer]);

    const cleanSecret = clientSecret.trim();

    const expectedSignature = crypto
      .createHmac('sha256', cleanSecret)
      .update(stringToSignBuffer)
      .digest('hex');

    const signatureBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (
      signatureBuffer.length !== expectedBuffer.length || 
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      this.logger.warn(`Signature mismatch. Expected ${expectedSignature}, got ${signature}`);
      throw new UnauthorizedException('Invalid signature');
    }

    this.logger.log('TikTok Webhook Signature Verified Successfully!');
    return true;
  }
}