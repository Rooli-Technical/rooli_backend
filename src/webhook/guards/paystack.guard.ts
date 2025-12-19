import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

interface RequestWithRawBody extends Request {
  rawBody: Buffer;
}

@Injectable()
export class PaystackWebhookGuard implements CanActivate {
  private readonly logger = new Logger(PaystackWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithRawBody>();
    const signature = request.headers['x-paystack-signature'];
    
    // Ensure we have the rawBody. If not, the configuration is still wrong.
    if (!request.rawBody) {
      this.logger.error('Paystack webhook received without rawBody. Check main.ts configuration.');
      return false;
    }

    const rawBody = request.rawBody; // This is a Buffer

    try {
      const hash = crypto
        .createHmac('sha512', this.config.get('PAYSTACK_SECRET_KEY'))
        .update(rawBody) // Update directly with the Buffer
        .digest('hex');

      if (hash === signature) {
        return true;
      }
      
      this.logger.warn(`Invalid Paystack Signature. Expected ${signature}, got ${hash}`);
      return false;
      
    } catch (error) {
      this.logger.error('Error verifying Paystack signature', error);
      return false;
    }
  }
}
