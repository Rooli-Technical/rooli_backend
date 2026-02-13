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
import { Prisma,UserType } from '@generated/client';
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
      user: { deletedAt: null },
    };

    // 2. Search Logic
    if (filters.search) {
      where.user = {
        deletedAt: null,
        OR: [
          { firstName: { contains: filters.search, mode: 'insensitive' } },
          { lastName: { contains: filters.search, mode: 'insensitive' } },
          { email: { contains: filters.search, mode: 'insensitive' } },
        ],
      };
    }

    if (filters.role) {
      where.roleId = filters.role;
    }

    // 4. Execution
    const [members, total] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where,
        take: limit,
        skip,
        include: {
          user: true,
          role: true,
          workspaceMemberships: { include: { workspace: true } }
        },
        orderBy: { joinedAt: 'desc' },
      }),
      this.prisma.organizationMember.count({ where }),
    ]);

    // 5. Mapping to safe response
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
