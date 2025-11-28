import {
  ForbiddenException,
  Injectable,
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
import { AuthService } from '@/auth/auth.service';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id, deletedAt: null },
    });
    return user ? this.toSafeUser(user) : null;
  }

  async getUsersByOrganization(
    organizationId: string,
    filters: UserFiltersDto,
  ) {

    const where: any = {
      deletedAt: null,
      organizationMemberships: {
        some: { organizationId, deletedAt: null },
      },
    };

    if (filters.role) where.role = filters.role;

    if (filters.search) {
      where.OR = [
        { firstName: { contains: filters.search, mode: 'insensitive' } },
        { lastName: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const page = filters.page || 1;
    const limit = filters.limit || 10;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: this.getSafeUserSelect(),
        skip: (page - 1) * limit,
        take: limit,
        orderBy: {
          [filters.sortBy || 'createdAt']: filters.sortOrder || 'desc',
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // ------------------ Update ------------------
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
        updatedAt: new Date(),
      },
    });

    return this.toSafeUser(user);
  }

async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });

    if (!user) {
      this.logger.error('User not found for password change', { userId });
      throw new NotFoundException('User not found');
    }

    // ✅ Use argon2 to match AuthService
    const isCurrentValid = await argon2.verify(user.password, dto.currentPassword);
    
    if (!isCurrentValid) {
      this.logger.warn('Invalid current password attempt', { userId });
      throw new UnauthorizedException('Current password is incorrect');
    }

    // ✅ Use AuthService method for consistency
    this.authService.validatePasswordStrength(dto.newPassword);
    const hashedPassword = await argon2.hash(dto.newPassword);

    // ✅ Use transaction with session revocation
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          password: hashedPassword,
          lastPasswordChange: new Date(),
          refreshToken: null, // Invalidate refresh token
          refreshTokenVersion: { increment: 1 }, // Invalidate all JWTs
        },
      });
    });

    this.logger.log('Password changed successfully', { userId });
  }

  async deactivateAccount(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });
  }


  private getSafeUserSelect() {
    return {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      avatar: true,
      role: true,
      isEmailVerified: true,
      lastActiveAt: true,
      createdAt: true,
    };
  }

  private toSafeUser(user: any): SafeUser {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      lastActiveAt: user.lastActiveAt,
    };
  }

   async getUserSocialAccounts(userId: string) {
    const memberships = await this.prisma.socialAccountMember.findMany({
      where: {
        userId,
      },
      include: {
        socialAccount: true,
      },
    });

    return memberships.map(m => ({
      id: m.socialAccount.id,
      platform: m.socialAccount.platform,
      accountName: m.socialAccount.name,
      isActive: m.socialAccount.isActive,
      connectedAt: m.createdAt,
    }));
  }
}
