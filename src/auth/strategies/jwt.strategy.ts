import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { PlanFeatures } from '@/common/constants/billing.types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('JWT_SECRET'),
    });
  }

  // src/auth/strategies/jwt.strategy.ts

  async validate(payload: JwtPayload) {
    // 1. Basic User Query (Always needed)
    // We separate the query construction because we can't filter memberships if orgId is null
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub, deletedAt: null },
      select: {
        id: true,
        email: true,
        lockedUntil: true,
        lastPasswordChange: true,
        refreshTokenVersion: true,
      },
    });

    if (!user) throw new UnauthorizedException();

    // --- Security Checks (Lock, Revocation, Password Change) ---
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException('Account is locked');
    }
    if (payload.ver !== user.refreshTokenVersion) {
      throw new UnauthorizedException('Session has been revoked');
    }
    if (user.lastPasswordChange) {
      if (payload.iat < user.lastPasswordChange.getTime() / 1000) {
        throw new UnauthorizedException('Password changed, please login again');
      }
    }

    // --- Handle "Onboarding" vs "Active" Context ---

    // Scenario A: User is Onboarding (No Org ID in token)
    if (!payload.orgId) {
      return {
        userId: user.id,
        email: user.email,
        organizationId: null,
        subscriptionStatus: 'inactive',
        roles: [],
        features: {}, // Default empty features
        limits: { maxWorkspaces: 0, maxTeamMembers: 0 }, // Strict limits
      };
    }

    // 3. Scenario B: Active Context (Fetch Specific Membership)
    // Since we have an orgId, we fetch specifically that membership with relations.
    const membership = await this.prisma.organizationMember.findFirst({
      where: {
        userId: user.id,
        organizationId: payload.orgId,
      },
      include: {
        role: { select: { name: true } },
        organization: {
          include: {
            subscription: {
              include: { plan: true },
            },
          },
        },
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    const org = membership.organization;
    const sub = org.subscription;
    const plan = sub?.plan;

    // A subscription is valid if status is 'active' AND it hasn't expired
    const isSubscriptionValid = 
      sub?.status === 'active' && 
      new Date() < sub.currentPeriodEnd;

    return {
      userId: user.id,
      email: user.email,
      organizationId: payload.orgId,
      workspaceId: payload.workspaceId,
      orgRoleId: membership.roleId,
      roles: [membership.role.name],
      features: (plan?.features as unknown as PlanFeatures) || {},
      userPlan: plan.tier,
      subscriptionStatus: isSubscriptionValid ? 'active' : 'inactive',
      limits: {
        maxWorkspaces: plan?.maxWorkspaces || 1,
        maxTeamMembers: plan?.maxTeamMembers || 1,
      },
    };
  }
}
