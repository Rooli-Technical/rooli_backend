import { PrismaService } from '@/prisma/prisma.service';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BYPASS_SUB_KEY } from '../decorators/bypass-subscription.decorator';
import { IS_ADMIN_ROUTE_KEY } from '../decorators/admin-route.decorator';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    //  Admin Bypass: Admins don't need SaaS subscriptions
    // const isAdminRoute = this.reflector.getAllAndOverride<boolean>(IS_ADMIN_ROUTE_KEY, [
    //   context.getHandler(),
    //   context.getClass(),
    // ]);

    // if (isAdminRoute) return true;

    if (request.path.startsWith('/api/v1/admin')) {
      return true;
    }

    //  Allow endpoints marked as Public or specifically for Billing
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    // 2. Check for "Bypass" routes (Billing, Profile Settings)
    const bypassSubscription = this.reflector.getAllAndOverride<boolean>(
      BYPASS_SUB_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (bypassSubscription) return true;

    const user = request.user;

    // Safety check: If AuthGuard failed or user is missing, stop here.
    if (!user || !user.organizationId) return false;

    if (user.subscriptionStatus === 'active') {
      return true;
    }

    if (user.subscriptionStatus === 'inactive') {
      throw new ForbiddenException({
        code: 'PAYMENT_REQUIRED',
        message: 'Your subscription is inactive or expired.',
        action: 'REDIRECT_TO_BILLING',
      });
    }

    // FALLBACK: Only query DB if the JWT info is missing or stale (Edge case)

    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId: user.organizationId },
      select: { status: true, currentPeriodEnd: true },
    });

    const isValid =
      sub && sub.status === 'active' && sub.currentPeriodEnd > new Date();

    if (!isValid) {
      throw new ForbiddenException({
        code: 'PAYMENT_REQUIRED',
        message: 'Your subscription has expired.',
        action: 'REDIRECT_TO_BILLING',
      });
    }

    return true;
  }
}
