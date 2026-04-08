import { PrismaService } from '@/prisma/prisma.service';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BYPASS_SUB_KEY } from '../decorators/bypass-subscription.decorator';



@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // 1. Bypass System Admin Routes
    if (request.path.startsWith('/api/v1/admin')) {
      return true;
    }

    // 2. Bypass Public Routes
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // 3. Bypass specific billing/settings routes (so they can actually pay!)
    const bypassSubscription = this.reflector.getAllAndOverride<boolean>(
      BYPASS_SUB_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (bypassSubscription) return true;

    const user = request.user;
    if (!user || !user.organizationId) return false;

    // 4. Fetch the absolute source of truth from the DB
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      include: {
        subscription: {
          select: { status: true, isTrial: true, trialEndsAt: true }, 
        },
      },
    });

    if (!org || !org.subscription) {
      throw new ForbiddenException({
        code: 'PAYMENT_REQUIRED',
        message: 'No active subscription found.',
        action: 'REDIRECT_TO_BILLING',
      });
    }

    const sub = org.subscription;
    const subStatus = sub.status; 

    // -------------------------------------------------------------
    // ENFORCEMENT LAYER 1: HARD LOCKOUTS
    // -------------------------------------------------------------
    if (
      org.status === 'SUSPENDED' ||
      subStatus === 'SUSPENDED' ||
      subStatus === 'CANCELED'
    ) {
      throw new ForbiddenException({
        code: 'PAYMENT_REQUIRED',
        message: 'Your account has been suspended or canceled.',
        action: 'REDIRECT_TO_BILLING',
      });
    }

    // -------------------------------------------------------------
    // ENFORCEMENT LAYER 2: THE DUNNING READ-ONLY MODE (Day 8-13)
    // -------------------------------------------------------------
    if (org.readOnly && request.method !== 'GET') {
      throw new ForbiddenException({
        code: 'READ_ONLY_MODE',
        message: 'Your account is in Read-Only mode due to a billing issue. Please update your payment method to restore full access.',
        action: 'REDIRECT_TO_BILLING',
      });
    }

    // -------------------------------------------------------------
    // ENFORCEMENT LAYER 2.5: CRON-DELAY FALLBACK (Trial Expiry)
    // -------------------------------------------------------------
    if (sub.isTrial && sub.trialEndsAt && new Date() > sub.trialEndsAt) {
      if (request.method !== 'GET') {
         throw new ForbiddenException({
           code: 'TRIAL_EXPIRED',
           message: 'Your free trial has ended. Please upgrade your plan to continue.',
           action: 'REDIRECT_TO_BILLING',
         });
      }
    }

    // -------------------------------------------------------------
    // ENFORCEMENT LAYER 3: ALLOWED STATES
    // -------------------------------------------------------------
    const allowedStates = ['ACTIVE', 'TRIALING', 'PAST_DUE'];
    
    if (allowedStates.includes(subStatus)) {
      return true;
    }

    // Fallback catch-all
    throw new ForbiddenException({
      code: 'PAYMENT_REQUIRED',
      message: 'Your subscription is inactive or expired.',
      action: 'REDIRECT_TO_BILLING',
    });
  }
}