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
 * Verifies Meta webhook signatures (x-hub-signature-256).
 *
 * REQUIREMENT:
 * - Your Express/Nest app MUST preserve the raw request body as a Buffer,
 *   otherwise signature verification is impossible.
 *
 * See `main.ts` snippet below.
 */
@Injectable()
export class MetaWebhookGuard implements CanActivate {
  private readonly logger = new Logger(MetaWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    this.logger.log('Verifying Meta/Instagram webhook signature...');
    const req = context.switchToHttp().getRequest<Request>();

    // Grab BOTH secrets from your environment
    const metaSecret = this.config.get<string>('META_CLIENT_SECRET');
    const igSecret = this.config.get<string>('INSTAGRAM_CLIENT_SECRET'); // Make sure this matches your .env!

    if (!metaSecret) {
      this.logger.error('META_CLIENT_SECRET is not set');
      throw new UnauthorizedException(
        'Webhook signature verification misconfigured',
      );
    }

    const signature = this.getSignature(req);
    if (!signature) {
      throw new UnauthorizedException('Missing Meta signature');
    }

    const raw = (req as any).rawBody as Buffer | undefined;
    if (!raw || !Buffer.isBuffer(raw)) {
      this.logger.error('rawBody not found on request.');
      throw new UnauthorizedException(
        'Webhook signature verification unavailable',
      );
    }

    // 1. Check against the standard Facebook/Meta Secret
    const expectedMeta = this.computeExpectedSignature(raw, metaSecret);
    if (this.timingSafeEqualHex(signature, expectedMeta)) {
      return true; // Validated via the core Meta App Secret
    }

    // 2. Check against the standalone Instagram Secret
    if (igSecret) {
      const expectedIg = this.computeExpectedSignature(raw, igSecret);
      if (this.timingSafeEqualHex(signature, expectedIg)) {
        return true; // Validated via the standalone Instagram App Secret
      }
    }

    // 3. If BOTH fail, reject the request
    this.logger.warn(
      `Meta signature mismatch. Request rejected. Got signature: ${signature}`,
    );
    throw new UnauthorizedException('Invalid Meta signature');
  }

  private getSignature(req: Request): string | null {
    const header =
      (req.headers['x-hub-signature-256'] as string | undefined) ??
      (req.headers['X-Hub-Signature-256'] as string | undefined);

    if (!header) return null;

    // Meta format: "sha256=<hex>"
    const [algo, hex] = header.split('=');
    if (algo !== 'sha256' || !hex) return null;

    return hex.trim();
  }

  private computeExpectedSignature(rawBody: Buffer, appSecret: string): string {
    return crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  }

  private timingSafeEqualHex(aHex: string, bHex: string): boolean {
    // Normalize
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
