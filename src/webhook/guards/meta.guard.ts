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
    console.log('MetaWebhookGuard: Verifying signature...');
    const req = context.switchToHttp().getRequest<Request>();

    const appSecret = this.config.get<string>('META_CLIENT_SECRET');
    if (!appSecret) {
      // Fail closed. No secret = no verification.
      this.logger.error('META_CLIENT_SECRET is not set');
      throw new UnauthorizedException('Webhook signature verification misconfigured');
    }

    const signature = this.getSignature(req);
    if (!signature) {
      throw new UnauthorizedException('Missing Meta signature');
    }

    const raw = (req as any).rawBody as Buffer | undefined;
    if (!raw || !Buffer.isBuffer(raw)) {
      this.logger.error(
        'rawBody not found on request. Ensure body parser captures rawBody.',
      );
      throw new UnauthorizedException('Webhook signature verification unavailable');
    }

    const expected = this.computeExpectedSignature(raw, appSecret);

    // Timing-safe compare
    const ok = this.timingSafeEqualHex(signature, expected);

    if (!ok) {
      this.logger.warn(`Meta signature mismatch. got=${signature} expected=${expected}`);
      throw new UnauthorizedException('Invalid Meta signature');
    }

    return true;
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
