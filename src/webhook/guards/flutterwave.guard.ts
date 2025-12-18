import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FlutterwaveWebhookGuard implements CanActivate {
  private readonly logger = new Logger(FlutterwaveWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const signature = request.headers['verif-hash'];
    const secretHash = this.config.get('FLUTTERWAVE_WEBHOOK_HASH');

    if (!signature || signature !== secretHash) {
      this.logger.warn(
        `Invalid Flutterwave Webhook Signature from IP: ${request.ip}`,
      );
      throw new UnauthorizedException('Invalid Signature');
    }

    return true;
  }
}
