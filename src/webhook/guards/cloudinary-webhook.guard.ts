import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as crypto from 'crypto';

@Injectable()
export class CloudinaryWebhookGuard implements CanActivate {
  private readonly logger = new Logger(CloudinaryWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();

    const signature = req.headers['x-cld-signature'] as string;
    const timestamp = req.headers['x-cld-timestamp'] as string;

    if (!signature || !timestamp) {
      throw new ForbiddenException('Missing Cloudinary signature headers');
    }

    const rawBody = req.rawBody?.toString();
    if (!rawBody) {
      throw new ForbiddenException('Missing request body');
    }

    const secret = this.config.get<string>('CLOUDINARY_API_SECRET');
    if (!secret) {
      // Fail loudly if misconfigured — don't silently reject every webhook
      this.logger.error('CLOUDINARY_API_SECRET is not configured');
      throw new ForbiddenException('Webhook configuration error');
    }

    const expected = crypto
      .createHash('sha1')
      .update(rawBody + timestamp + secret)
      .digest('hex');

    if (expected !== signature) {
      this.logger.warn('Cloudinary webhook signature mismatch');
      throw new ForbiddenException('Invalid Cloudinary signature');
    }

    // Replay protection — reject webhooks older than 1 hour
    const webhookAge = Date.now() / 1000 - parseInt(timestamp, 10);
    if (webhookAge > 3600) {
      this.logger.warn(`Stale Cloudinary webhook: ${webhookAge}s old`);
      throw new ForbiddenException('Stale webhook');
    }

    return true;
  }
}