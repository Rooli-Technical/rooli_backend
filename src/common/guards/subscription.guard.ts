import { PrismaService } from "@/prisma/prisma.service";
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Allow endpoints marked as Public or specifically for Billing
    const isPublic = this.reflector.get<boolean>('isPublic', context.getHandler());
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const orgId = request.user?.organizationId;

    if (!orgId) return false; // Should be handled by AuthGuard, but safety first

    // 2. Fetch Subscription Status
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: { status: true, currentPeriodEnd: true }
    });

    // 3. THE CHECK: Must be Active AND within valid dates
    const isValid = 
      sub && 
      sub.status === 'active' && 
      sub.currentPeriodEnd > new Date();

    if (!isValid) {
      throw new ForbiddenException({
        code: 'PAYMENT_REQUIRED', // Frontend listens for this specific code
        message: 'Your subscription has expired. Access is restricted.',
        action: 'REDIRECT_TO_BILLING'
      });
    }

    return true;
  }
}