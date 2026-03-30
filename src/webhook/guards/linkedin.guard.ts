import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class LinkedInWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const signature = req.headers['x-li-signature'];

    if (!signature) {
      throw new UnauthorizedException('Missing X-LI-Signature header');
    }

    const clientSecret = this.config.get<string>('LINKEDIN_CLIENT_SECRET');

    const rawBody = req.rawBody;

    if (!rawBody) {
      throw new UnauthorizedException(
        'Raw body is required for webhook verification',
      );
    }

    // LinkedIn computes the signature using HMAC SHA256
    const expectedSignature = crypto
      .createHmac('sha256', clientSecret)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      throw new UnauthorizedException('Invalid LinkedIn webhook signature');
    }

    return true;
  }
}
