import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Register } from './dtos/Register.dto';
import * as crypto from 'crypto';
import { Login } from './dtos/Login.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { AuthResponse, SafeUser } from './dtos/AuthResponse.dto';
import { ForgotPassword } from './dtos/ForgotPassword.dto';
import { ResetPassword } from './dtos/ResetPassword.dto';
import { MailService } from '@/mail/mail.service';
import { PrismaService } from '@/prisma/prisma.service';
import { User } from '@generated/client';
import * as argon2 from 'argon2';
import { Cron, CronExpression } from '@nestjs/schedule';
import slugify from 'slugify';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly MAX_LOGIN_ATTEMPTS = 5;
  private readonly LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: MailService,
  ) {}

  async register(registerDto: Register) {
    try{
    const { email, password, firstName, lastName, role, companyName, timezone } =
      registerDto;
    const lowerEmail = email.toLowerCase();

    // Check if User exists AND fetch required Roles simultaneously
    const [existingUser, systemRole, orgOwnerRole] = await Promise.all([
      this.prisma.user.findUnique({
        where: { email: lowerEmail },
        select: { id: true },
      }),
      // The role the user has in the system (e.g., 'USER')
      this.prisma.role.findFirst({
        where: { name: role, scope: 'SYSTEM' },
      }),
      // The role the user has in the Organization (e.g., 'OWNER')
      this.prisma.role.findFirst({
        where: { name: 'owner', scope: 'ORGANIZATION' },
      }),
    ]);

    if (existingUser) throw new ConflictException('User already exists');
    if (!systemRole)
      throw new BadRequestException(`Invalid system role: ${role}`);
    if (!orgOwnerRole)
      throw new InternalServerErrorException(
        'System configuration error: Owner role missing',
      );

    this.validatePasswordStrength(password);

    const hashedPassword = await argon2.hash(password);
    const slug = slugify(companyName, { lower: true, strict: true });

    const slugExists = await this.prisma.organization.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (slugExists) {
      throw new ConflictException(
        'Organization with this name already exists. Please choose a different name.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // A. Create User
      const newUser = await tx.user.create({
        data: {
          email: lowerEmail,
          password: hashedPassword,
          firstName: firstName?.trim(),
          lastName: lastName?.trim(),
          systemRoleId: systemRole.id,
          emailVerificationSentAt: new Date(),
          lastPasswordChange: new Date(),
          timezone,
        },include:  {
          systemRole: { select: { name: true } },
        }
      });

      // Create Organization & Link Member
      const newOrg = await tx.organization.create({
        data: {
          name: companyName,
          slug: slug, // You might need a loop here to ensure slug uniqueness in prod
          planTier: 'FREE',
          members: {
            create: {
              userId: newUser.id,
              roleId: orgOwnerRole.id, // Linked to Organization Role
            },
          },
        },
      });

      return { user: newUser, org: newOrg };
    });

    // Generate Tokens with Context (Org ID)
    const tokens = await this.generateTokens(
      result.user.id,
      result.user.email,
      result.org.id,
      0,
      timezone
    );
    const refreshHash = await argon2.hash(tokens.refreshToken);

    //  Update User Token
    // We update the user with the refresh token and set their Last Active Org preference
    await this.prisma.user.update({
      where: { id: result.user.id },
      data: {
        refreshToken: refreshHash,
        refreshTokenVersion: 0,
        lastActiveOrgId: result.org.id,
      },
    });

    this.logger.log(`Registered user ${lowerEmail} with Org ${result.org.id}`);

    return {
      user: this.toSafeUser(result.user),
      ...tokens,
      requiresEmailVerification: true,
    };
  } catch (error) {
    console.log(error);
    throw error;
  }
  }
  async login(loginDto: Login) {
    const email = loginDto.email.toLowerCase();

    // We need memberships to decide which Org ID goes into the token
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      include: {
        systemRole: { select: { name: true } },
        organizationMemberships: {
          select: { organizationId: true }, 
          take: 5,
          orderBy: { lastActiveAt: 'desc' } 
        },
        lastActiveOrganization: { select: { id: true } },
      },
      
    });

    if (!user) {
      await this.simulateProcessingDelay(); 
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException(
        `Account locked until ${user.lockedUntil.toISOString()}`,
      );
    }

    const isPasswordValid = await argon2.verify(
      user.password,
      loginDto.password,
    );
    if (!isPasswordValid) {
      await this.handleFailedLogin(user.id);
      throw new UnauthorizedException('Invalid credentials');
    }

    //  Determine Active Organization
    // Otherwise, default to the first membership found.
    let activeOrgId = user.lastActiveOrganization.id;

    // CHECK: Does she still have access?
    const hasAccess = user.organizationMemberships.some(
      (m) => m.organizationId === activeOrgId,
    );

    if (!hasAccess) {
      // Fallback: If she was kicked out, default to her first available org
      activeOrgId = user.organizationMemberships[0]?.organizationId;

      // Optional: Clean up the database
      if (activeOrgId) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { lastActiveOrgId: activeOrgId },
        });
      }
    }

    if (!activeOrgId) {
      throw new ForbiddenException('No active workspace found for this user');
    }

    // Generate Tokens
    const tokens = await this.generateTokens(user.id, user.email, activeOrgId, user.refreshTokenVersion, user.timezone);
    const refreshHash = await argon2.hash(tokens.refreshToken);

    // Reset security counters, update stats, and save refresh token in ONE call
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        loginAttempts: 0,
        lockedUntil: null,
        lastActiveAt: new Date(),
        refreshToken: refreshHash,
        lastActiveOrgId: activeOrgId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatar: true,
        isEmailVerified: true,
        systemRole: { select: { name: true } },
        
      },
    });

    this.logger.log(
      `Logged in: ${user.email} | Active Context: ${activeOrgId}`,
    );

    return {
      user: updatedUser, 
      ...tokens,
      requiresEmailVerification: !updatedUser.isEmailVerified,
    };
  }

  async refreshTokens(refreshToken: string): Promise<AuthResponse> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
      });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub, deletedAt: null },
        include: {
          // Check if membership still exists for the Org ID in the token
          organizationMemberships: {
            where: { organizationId: payload.orgId },
            select: { organizationId: true }
          },
        }
      });

      if (!user) throw new UnauthorizedException('User not found');

      if (!user.refreshToken) {
        throw new UnauthorizedException('No active session');
      }

      if (user.refreshTokenVersion !== payload.ver) {
        // Token has been invalidated (logout, password change, etc.)
        await this.prisma.user.update({
          where: { id: user.id },
          data: { refreshToken: null },
        });
        this.logger.warn(
          `Refresh token version mismatch for user ${user.email}`,
        );
        throw new UnauthorizedException('Invalid refresh token');
      }

      const isValidRefreshToken = await argon2.verify(
        user.refreshToken,
        refreshToken,
      );

    if (!isValidRefreshToken) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { refreshToken: null },
        });
        throw new UnauthorizedException('Invalid refresh token');
      }

      // 4. Determine Org Context
      let targetOrgId = payload.orgId;

      if (user.organizationMemberships.length === 0) {
        const fallback = await this.prisma.organizationMember.findFirst({
           where: { userId: user.id },
           select: { organizationId: true }
        });
        
        if (!fallback) throw new ForbiddenException('No active workspace found');
        targetOrgId = fallback.organizationId;
      }

      const tokens = await this.generateTokens(user.id, user.email, targetOrgId, user.refreshTokenVersion, user.timezone);
      const newHash = await argon2.hash(tokens.refreshToken);

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          refreshToken: newHash,
          refreshTokenVersion: { increment: 1 },
          lastActiveAt: new Date(),
        },
      });
      return {
        user: this.toSafeUser(user as any),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        requiresEmailVerification: !user.isEmailVerified,
      };
    } catch (error) {
      this.logger.warn('Invalid refresh token attempt');
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async verifyEmail(token: string): Promise<void> {
    try {
      const expirationTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours

      const candidates = await this.prisma.user.findMany({
        where: {
          emailVerificationToken: { not: null },
          emailVerificationSentAt: { gte: expirationTime },
          deletedAt: null,
        },
        select: { id: true, email: true, emailVerificationToken: true },
      });

      let matched: { id: string; email: string } | null = null;
      for (const c of candidates) {
        if (!c.emailVerificationToken) continue;
        const ok = await argon2.verify(c.emailVerificationToken, token);
        if (ok) {
          matched = { id: c.id, email: c.email };
          break;
        }
      }

      if (!matched) {
        await this.simulateProcessingDelay();
        throw new BadRequestException('Invalid or expired verification token');
      }

      await this.prisma.user.update({
        where: { id: matched.id },
        data: {
          isEmailVerified: true,
          emailVerificationToken: null,
          emailVerificationSentAt: null,
        },
      });

      this.logger.log(`Email verified for user: ${matched.email}`);
    } catch (err) {
      throw err;
    }
  }

  async forgotPassword(dto: ForgotPassword): Promise<User> {
    try {
      const user = await this.prisma.user.findUnique({
        where: {
          email: dto.email.toLowerCase(),
          deletedAt: null,
        },
      });

      if (!user) {
        await this.simulateProcessingDelay();
        return;
      }

      const { plainToken, hashedToken } =
        await this.generateVerificationToken();
      const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      const _user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          resetPasswordToken: hashedToken,
          resetPasswordExpires: resetExpires,
        },
      });

      this.emailService
        .sendPasswordResetEmail(user.email, plainToken)
        .catch((err) => this.logger.error('Failed to send reset email:', err));

      this.logger.log(`Password reset requested for: ${user.email}`);
      return _user;
    } catch (err) {
      throw err;
    }
  }

  async resetPassword(dto: ResetPassword): Promise<void> {
    try {
      const now = new Date();

      const candidates = await this.prisma.user.findMany({
        where: {
          resetPasswordToken: { not: null },
          resetPasswordExpires: { gt: now },
          deletedAt: null,
        },
        select: { id: true, email: true, resetPasswordToken: true },
      });

      let matched: { id: string; email: string } | null = null;
      for (const c of candidates) {
        if (!c.resetPasswordToken) continue;
        const ok = await argon2.verify(c.resetPasswordToken, dto.token);
        if (ok) {
          matched = { id: c.id, email: c.email };
          break;
        }
      }

      if (!matched) {
        await this.simulateProcessingDelay();
        throw new BadRequestException('Invalid or expired reset token');
      }

      this.validatePasswordStrength(dto.password);
      const hashedPassword = await argon2.hash(dto.password);

      await this.prisma.user.update({
        where: { id: matched.id },
        data: {
          password: hashedPassword,
          resetPasswordToken: null,
          resetPasswordExpires: null,
          loginAttempts: 0,
          lockedUntil: null,
          lastPasswordChange: new Date(),
          refreshTokenVersion: { increment: 1 },
        },
      });

      this.logger.log(`Password reset successful for ${matched.email}`);
    } catch (err) {
      this.logger.error(err);
      throw err;
    }
  }

  async logout(userId: string): Promise<void> {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          refreshToken: null,
          lastActiveAt: new Date(),
        },
      });

      this.logger.log(`User logged out: ${userId}`);
    } catch (err) {
      this.logger.error(err);
      throw err;
    }
  }

  async resendVerificationEmail(email: string): Promise<void> {
    try {
      const user = await this.prisma.user.findFirst({
        where: {
          email: email.toLowerCase(),
          deletedAt: null,
          isEmailVerified: false,
        },
      });

      if (!user) return; // Silent fail for security

      const { plainToken, hashedToken } =
        await this.generateVerificationToken();

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerificationToken: hashedToken,
          emailVerificationSentAt: new Date(),
        },
      });

      this.sendVerificationEmail(user.email, plainToken);
    } catch (err) {
      this.logger.error(err);
      throw err;
    }
  }

  async handleSocialLogin(googleUser: { email: string; firstName: string; lastName: string; picture: string }, timezone: string) {
  try {
    const lowerEmail = googleUser.email.toLowerCase();

    //  Check if user exists
    let user = await this.prisma.user.findUnique({
      where: { email: lowerEmail },
      include: {
        systemRole: { select: { name: true } },
        lastActiveOrganization: { select: { id: true } },
        organizationMemberships: { take: 1, select: { organizationId: true } }
      }
    });

    //  If User exists, just log them in
    if (user) {
      // Determine active Org
      let activeOrgId = user.lastActiveOrganization?.id || user.organizationMemberships[0]?.organizationId;
      
      if (!activeOrgId) throw new ForbiddenException('User exists but has no active workspace.');

      const tokens = await this.generateTokens(user.id, user.email, activeOrgId, user.refreshTokenVersion, user.timezone);
      const refreshHash = await argon2.hash(tokens.refreshToken);

      await this.prisma.user.update({
        where: { id: user.id },
        data: { 
          refreshToken: refreshHash, 
          lastActiveAt: new Date(),
          isEmailVerified: true,
          // If they didn't have an avatar, update it from Google
          avatar: user.avatar || googleUser.picture 
        },
      });

      return { user: this.toSafeUser(user), ...tokens };
    }

    // If User DOES NOT exist, Register them automatically
    // We need to auto-generate a Company Name since Google doesn't give us one.
    const companyName = `${googleUser.firstName}'s Workspace`;
    const slug = slugify(companyName, { lower: true, strict: true }) + '-' + Math.floor(Math.random() * 1000);
    
    // Fetch Roles 
    const [systemRole, orgOwnerRole] = await Promise.all([
      this.prisma.role.findFirst({ where: { name: 'user', scope: 'SYSTEM' } }),
      this.prisma.role.findFirst({ where: { name: 'owner', scope: 'ORGANIZATION' } }),
    ]);

    // Transaction: Create User + Org + Member
    const result = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: lowerEmail,
          // Generate a random high-entropy password so they can't login via password yet (unless they reset it)
          password: await argon2.hash(crypto.randomBytes(32).toString('hex')), 
          firstName: googleUser.firstName,
          lastName: googleUser.lastName,
          avatar: googleUser.picture,
          isEmailVerified: true, 
          timezone,
          systemRoleId: systemRole.id,
          lastPasswordChange: new Date(),
        },
        include: { systemRole: { select: { name: true } } }
      });

      const newOrg = await tx.organization.create({
        data: {
          name: companyName,
          slug: slug,
          planTier: 'FREE',
          members: {
            create: {
              userId: newUser.id,
              roleId: orgOwnerRole.id,
            },
          },
        },
      });

      return { user: newUser, org: newOrg };
    });

    // Generate Tokens
    const tokens = await this.generateTokens(result.user.id, result.user.email, result.org.id, 0, timezone);
    const refreshHash = await argon2.hash(tokens.refreshToken);

    // Save Refresh Token
    await this.prisma.user.update({
      where: { id: result.user.id },
      data: { refreshToken: refreshHash, lastActiveOrgId: result.org.id },
    });
    return { user: this.toSafeUser(result.user), ...tokens };

  } catch (error) {
    this.logger.error(error);
    throw new InternalServerErrorException('Google login failed');
  }
}

  private async generateTokens(userId: string, email: string, orgId: string, version: number, timezone: string) {
    const payload: JwtPayload = {
      sub: userId,
      email,
      orgId,
      ver: version,
      timezone
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_SECRET'),
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private async handleFailedLogin(userId: string): Promise<void> {
    try {
      // Atomically increment loginAttempts and read updated value within a transaction
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: {
            loginAttempts: { increment: 1 },
            lastActiveAt: new Date(),
          },
        });

        return tx.user.findUnique({
          where: { id: userId },
          select: { loginAttempts: true, email: true },
        });
      });

      if (!updated) return;

      if (updated.loginAttempts >= this.MAX_LOGIN_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + this.LOCKOUT_DURATION_MS);
        await this.prisma.user.update({
          where: { id: userId },
          data: { lockedUntil },
        });
        this.logger.warn(
          `Account locked for user ${updated.email} until ${lockedUntil.toISOString()}`,
        );
      }
    } catch (err) {
      this.logger.error(err);
      throw err;
    }
  }

  private async generateVerificationToken(): Promise<{
    plainToken: string;
    hashedToken: string;
  }> {
    try {
      const plainToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = await argon2.hash(plainToken);
      console.log(plainToken);
      return { plainToken, hashedToken };
    } catch (err) {
      this.logger.error(err);
      throw err;
    }
  }

  validatePasswordStrength(password: string): void {
    if (password.length < 8) {
      throw new BadRequestException(
        'Password must be at least 8 characters long',
      );
    }

    const strengthChecks = {
      hasLowercase: /[a-z]/.test(password),
      hasUppercase: /[A-Z]/.test(password),
      hasNumbers: /\d/.test(password),
      hasSpecialChar: /[!@#$%^&*(),.?":{}|<>]/.test(password),
    };

    const strengthScore = Object.values(strengthChecks).filter(Boolean).length;

    if (strengthScore < 3) {
      throw new BadRequestException(
        'Password must contain at least 3 of the following: lowercase, uppercase, numbers, special characters',
      );
    }
  }

  private async simulateProcessingDelay(): Promise<void> {
    // Add random delay between 100-500ms to prevent timing attacks
    const delay = Math.random() * 400 + 100;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async sendVerificationEmail(
    email: string,
    token: string,
  ): Promise<void> {
    try {
      await this.emailService.sendVerificationEmail(email, token);
      this.logger.log(`Verification email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send verification email to ${email}`, {
        error,
      });
      throw error;
    }
  }

  private toSafeUser(user): SafeUser {
    console.log(user);
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      role: user.systemRole.name,
      isEmailVerified: user.isEmailVerified,
      lastActiveAt: user.lastActiveAt,
    };
  }

  @Cron(CronExpression.EVERY_WEEK)
  async cleanupStaleRefreshTokens() {
    const result = await this.prisma.user.updateMany({
      where: {
        lastActiveAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        refreshToken: { not: null },
      },
      data: {
        refreshToken: null,
        refreshTokenVersion: { increment: 1 },
      },
    });
    this.logger.log(
      `Cleaned up stale refresh tokens for ${result.count} users`,
    );
  }
}
