import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class MetaWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // Meta verification challenge (GET request) - Always allow
    if (request.method === 'GET' && request.query['hub.mode'] === 'subscribe') {
      return true;
    }

    //  Event notification (POST request) - Verify Signature
    if (request.method === 'POST') {
      const signature = request.headers['x-hub-signature-256']; // or x-hub-signature (sha1)
      if (!signature) throw new UnauthorizedException('No signature found');

      const appSecret = this.config.get('META_CLIENT_SECRET');
      const hmac = crypto.createHmac('sha256', appSecret);

      // Note: NestJS needs raw body for this.
      // Ensure you configured 'rawBody: true' in main.ts or use a specific middleware
      const digest = 'sha256=' + hmac.update(request.rawBody).digest('hex');

      if (signature !== digest) {
        throw new UnauthorizedException('Invalid Meta Signature');
      }
    }

    return true;
  }
}
