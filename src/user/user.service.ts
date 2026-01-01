import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { UpdateProfileDto } from './dtos/update-profile.dto';
import { UserFiltersDto } from './dtos/user-filters.dto';
import * as argon2 from 'argon2';
import { SafeUser } from '@/auth/dtos/AuthResponse.dto';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma, SubscriptionGateway, UserType } from '@generated/client';
import slugify from 'slugify';
import { OnboardingDto } from '../auth/dtos/user-onboarding.dto';
import { BillingService } from '@/billing/billing.service';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
  ) {}

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id, deletedAt: null },
      include: {
        organizationMemberships: {
          include: {
            organization: {
              include: { subscription: { include: { plan: true } } },
            },
          },
        },
      },
    });

    if (!user) return null;

    const safeUser = this.toSafeUser(user);

    return safeUser;
  }

  async getUsersByOrganization(
    organizationId: string,
    filters: UserFiltersDto,
  ) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.OrganizationMemberWhereInput = {
      organizationId,
      isActive: true,
      user: { deletedAt: null },
    };

    if (filters.search) {
      where.user = {
        is: {
          deletedAt: null,
          OR: [
            { firstName: { contains: filters.search, mode: 'insensitive' } },
            { lastName: { contains: filters.search, mode: 'insensitive' } },
            { email: { contains: filters.search, mode: 'insensitive' } },
          ],
        },
      };
    }

    if (filters.role) {
      where.roleId = filters.role;
    }

    const [members, total] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where,
        take: limit,
        skip,
        include: {
          user: true,
          role: true,
        },
        orderBy: { joinedAt: 'desc' },
      }),
      this.prisma.organizationMember.count({ where }),
    ]);

    return {
      data: members.map((member) => ({
        ...this.toSafeUser(member.user),
        orgRole: member.role,
        joinedAt: member.joinedAt,
        memberId: member.id,
      })),
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async updateProfile(
    userId: string,
    updateData: UpdateProfileDto,
  ): Promise<SafeUser> {
    const user = await this.prisma.user.update({
      where: { id: userId, deletedAt: null },
      data: {
        firstName: updateData.firstName?.trim(),
        lastName: updateData.lastName?.trim(),
        avatar: updateData.avatar,
      },
    });

    return this.toSafeUser(user);
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('User not found');

    const isCurrentValid = await argon2.verify(
      user.password,
      dto.currentPassword,
    );
    if (!isCurrentValid)
      throw new UnauthorizedException('Current password is incorrect');

    this.validatePasswordStrength(dto.newPassword);
    const hashedPassword = await argon2.hash(dto.newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        lastPasswordChange: new Date(),
        refreshToken: null, // Revoke sessions
        refreshTokenVersion: { increment: 1 },
      },
    });

    this.logger.log('Password changed successfully', { userId });
  }

  async deactivateMyAccount(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        refreshToken: null,
        refreshTokenVersion: { increment: 1 },
        lastActiveAt: new Date(),
      },
    });
    this.logger.log(`User account deactivated`, { userId });
  }

// auth.service.ts

async userOnboarding(userId: string, dto: OnboardingDto) {
  const user = await this.prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundException('User not found');

  // Prevent double onboarding
  const existingOrg = await this.prisma.organizationMember.findFirst({
    where: { userId: user.id }
  });
  if (existingOrg) throw new ConflictException('User already has an organization');

  // 1. Prepare Slugs & Roles
  const orgName = dto.name;
  const workspaceName = dto.initialWorkspaceName || 'General';
  const orgSlug = await this.generateUniqueOrgSlug(orgName);

  // 2. TRANSACTION: Create Everything
  const result = await this.prisma.$transaction(async (tx) => {
    // A. Update User Type (if selected)
    if (dto.userType) {
      await tx.user.update({ where: { id: userId }, data: { userType: dto.userType } });
    }

    // B. Create Organization
    const org = await tx.organization.create({
      data: {
        name: orgName,
        slug: orgSlug,
        billingEmail: user.email,
        members: {
          create: {
            userId: user.id,
            roleId: (await this.fetchRole(tx, 'owner', 'ORGANIZATION')).id,
          },
        },
      },
    });

    // C. Create Default Workspace
    const workspace = await tx.workspace.create({
      data: {
        name: workspaceName,
        slug: slugify(workspaceName, { lower: true }),
        organizationId: org.id,
        members: {
          create: {
            userId: user.id,
            roleId: (await this.fetchRole(tx, 'admin', 'WORKSPACE')).id,
          },
        },
      },
    });

    // D. Create Brand Kit
    await tx.brandKit.create({
      data: { workspaceId: workspace.id, name: `${orgName} Brand Kit` },
    });

    // E. Update User Context (Sticky Session)
    const updatedUser = await tx.user.update({
      where: { id: user.id },
      data: { 
        lastActiveWorkspaceId: workspace.id,
        isOnboardingComplete: true
      },
      include: { systemRole: true }
    });

    // F. Generate NEW Tokens (Now containing the OrgID and WorkspaceID)
    // The old token is invalid for accessing app features because orgId was null.
    const newTokens = await this.generateTokens(
      updatedUser.id, updatedUser.email, org.id, workspace.id, updatedUser.refreshTokenVersion
    );
    
    // Save new refresh token
    await tx.user.update({
      where: { id: user.id },
      data: { refreshToken: await argon2.hash(newTokens.refreshToken) }
    });

    return { user: updatedUser, tokens: newTokens, workspaceId: workspace.id };
  });

  return {
    user: this.toSafeUser(result.user),
    ...result.tokens, // Frontend must replace the old token with this one!
    activeWorkspaceId: result.workspaceId
  };
}

  private validatePasswordStrength(password: string): void {
    if (password.length < 8)
      throw new BadRequestException('Password too short');

    // Quick Regex check for complexity
    const hasStrongChars = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d|.*[!@#$%^&*]).{8,}$/;
    if (!hasStrongChars.test(password)) {
      throw new BadRequestException(
        'Password needs uppercase, lowercase, and a number or symbol',
      );
    }
  }

  private async fetchSystemRole(roleName: string) {
    const role = await this.prisma.role.findFirst({
      where: { name: roleName }, // Assuming scope: 'SYSTEM' or 'ORGANIZATION'
    });

    if (!role)
      throw new InternalServerErrorException(
        `System Role '${roleName}' not found`,
      );

    return role;
  }

  private toSafeUser(user: any): SafeUser {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      userType: user.userType,
      isEmailVerified: user.isEmailVerified,
      lastActiveAt: user.lastActiveAt,
    };
  }
}
