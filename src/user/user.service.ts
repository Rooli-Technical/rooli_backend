import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { UpdateProfileDto } from './dtos/update-profile.dto';
import * as argon2 from 'argon2';
import { SafeUser } from '@/auth/dtos/AuthResponse.dto';
import { PrismaService } from '@/prisma/prisma.service';
import { BillingService } from '@/billing/billing.service';
import * as crypto from 'crypto';
import { MailService } from '@/mail/mail.service';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: MailService,
  ) {}

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id, deletedAt: null },
      include: {
        avatar: true,
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

  async getUserWorkspaces(userId: string) {
    // 1. Verify user exists
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

    // 2. Fetch Workspaces through the Membership chain
    // We look for WorkspaceMembers where the "parent" OrganizationMember belongs to this User
    const workspaces = await this.prisma.workspace.findMany({
      where: {
        members: {
          some: {
            member: {
              userId: userId,
            },
          },
        },
      },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        // Include the user's specific role in this workspace
        members: {
          where: {
            member: {
              userId: userId,
            },
          },
          include: {
            role: true,
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    // 3. Transform to a cleaner structure
    return workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      timezone: workspace.timezone,
      organization: workspace.organization,
      // Extract the single role object for the current user
      userRole: workspace.members[0]?.role || null,
    }));
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
      },
    });

    return this.toSafeUser(user);
  }

  async requestChangePasswordOtp(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });

    if (!user) throw new NotFoundException('User not found');

    // 1. Generate a secure 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();

    // 2. Hash the OTP (Do NOT store plain text OTPs)
    const hashedOtp = await argon2.hash(otp);

    // 3. Set Expiration (15 minutes from now)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // 4. Save to Database
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordResetOtp: hashedOtp,
        passwordResetOtpExpires: expiresAt,
      },
    });

    // 5. Send Email with the plain text OTP
    await this.emailService
      .sendPasswordResetOtp(user.email, user.firstName, otp)
      .catch((err) =>
        this.logger.error(
          `Failed to send change-password OTP to ${user.email}`,
          err,
        ),
      );
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('User not found');

    // 1. Verify Current Password
    const isCurrentValid = await argon2.verify(
      user.password,
      dto.currentPassword,
    );
    if (!isCurrentValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // 2. Verify OTP Existence & Expiration
    if (!user.passwordResetOtp || !user.passwordResetOtpExpires) {
      throw new BadRequestException('Please request an OTP first');
    }

    if (new Date() > user.passwordResetOtpExpires) {
      // Clean up the expired OTP
      await this.prisma.user.update({
        where: { id: userId },
        data: { passwordResetOtp: null, passwordResetOtpExpires: null },
      });
      throw new BadRequestException(
        'OTP has expired. Please request a new one.',
      );
    }

    // 3. Verify OTP Match
    const isValidOtp = await argon2.verify(user.passwordResetOtp, dto.otp);
    if (!isValidOtp) {
      throw new BadRequestException('Invalid OTP');
    }

    // 4. Validate & Hash New Password
    this.validatePasswordStrength(dto.newPassword);
    const hashedPassword = await argon2.hash(dto.newPassword);

    // 5. Update User & Cleanup
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        lastPasswordChange: new Date(),
        passwordResetOtp: null,
        passwordResetOtpExpires: null,
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
      avatar: user.avatar
        ? {
            ...user.avatar,
            size: user.avatar.size.toString(),
          }
        : null,
      userType: user.userType,
      isEmailVerified: user.isEmailVerified,
      lastActiveAt: user.lastActiveAt,
    };
  }
}
