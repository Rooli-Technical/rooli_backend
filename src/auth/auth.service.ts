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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: MailService,
  ) {}

  async register(registerDto: Register) {
    const { email, password, firstName, lastName, timezone } = registerDto;
    const lowerEmail = email.toLowerCase();

    // Check Existence
    const existingUser = await this.prisma.user.findUnique({
      where: { email: lowerEmail },
    });
    if (existingUser) throw new ConflictException('User already exists');

    // Hash Password
    this.validatePasswordStrength(password);
    const hashedPassword = await argon2.hash(password);

    // Fetch the "user" role with scope "system"
  const role = await this.prisma.role.findFirst({
    where: { name: 'user', scope: 'SYSTEM' },
  });
  if (!role) {
    throw new InternalServerErrorException(
      "Default role 'user' with scope not found"
    );
  }

    //  Create User (No Org yet)
    const newUser = await this.prisma.user.create({
      data: {
        email: lowerEmail,
        password: hashedPassword,
        firstName: firstName?.trim(),
        lastName: lastName?.trim(),
        timezone,
        systemRoleId: role.id,
        userType: 'INDIVIDUAL',
      },
      include: {
        systemRole: true,
      }
    });

    //  Generate "Onboarding Token" (Org ID is NULL)
    const tokens = await this.generateTokens(
      newUser.id,
      newUser.email,
      null,
      0,
    );

    //  Save Refresh Token
    const refreshHash = await argon2.hash(tokens.refreshToken);
    await this.prisma.user.update({
      where: { id: newUser.id },
      data: { refreshToken: refreshHash },
    });

    return {
      user: this.toSafeUser(newUser),
      ...tokens,
      // Frontend sees this is null -> Redirects to /onboarding
      organizationId: null,
    };
  }

  async login(loginDto: Login) {
    const email = loginDto.email.toLowerCase();

    // 1. Fetch User & Memberships
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      include: {
        organizationMemberships: {
          where: { organization: { status: 'ACTIVE' } }, 
          select: { organizationId: true },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
        systemRole: true,
      },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const validPass = await argon2.verify(user.password, loginDto.password);
    if (!validPass) throw new UnauthorizedException('Invalid credentials');

    // RESOLVE CONTEXT (Which Org?)
    let activeOrgId = user.lastActiveOrgId;

    // Verify access to the "last active" org
    // (We query DB briefly to ensure they weren't kicked out since last login)
    if (activeOrgId) {
      const hasAccess = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            userId: user.id,
            organizationId: activeOrgId,
          },
        },
      });
      if (!hasAccess) activeOrgId = null;
    }

    // Fallback: If no last active (or lost access), use their most recent org
    if (!activeOrgId && user.organizationMemberships.length > 0) {
      activeOrgId = user.organizationMemberships[0].organizationId;
    }

    // 3. GENERATE TOKEN
    // If activeOrgId is still null here, it means they have NO organizations.
    // The token will have orgId: null, and Frontend will redirect to Onboarding.
    const tokens = await this.generateTokens(
      user.id,
      user.email,
      activeOrgId, // Can be null
      user.refreshTokenVersion,
    );

    // 4. Update User Stats
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastActiveAt: new Date(),
        lastActiveOrgId: activeOrgId, 
        refreshToken: await argon2.hash(tokens.refreshToken),
      },
    });

    return { ...tokens, user: this.toSafeUser(user) };
  }

  async switchOrganization(userId: string, targetOrgId: string) {
  // 1. Verify Membership
  const membership = await this.prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: { userId, organizationId: targetOrgId }
    },
    include: { organization: true }
  });

  if (!membership) {
    throw new ForbiddenException('You are not a member of this organization');
  }

  if (membership.organization.status !== 'ACTIVE') {
    throw new ForbiddenException('This organization is currently suspended or pending payment');
  }

  // 2. Update User "Sticky" Preference
  const user = await this.prisma.user.update({
    where: { id: userId },
    data: { lastActiveOrgId: targetOrgId }
  });

  // 3. Issue NEW Token with Target Org ID
  const tokens = await this.generateTokens(
    userId,
    user.email,
    targetOrgId, 
    user.refreshTokenVersion
  );

  // Update refresh token hash in DB
  await this.updateRefreshToken(userId, tokens.refreshToken);

  return tokens;
}

async refreshTokens(refreshToken: string): Promise<AuthResponse> {
    try {
      // Verify Structure
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
      });

      // 2. Fetch User & Validate Session
     const user = await this.prisma.user.findUnique({
        where: { id: payload.sub, deletedAt: null },
        include: { systemRole: true } 
      });

      if (!user || !user.refreshToken) {
        throw new UnauthorizedException('Access Denied');
      }

      // Version Check (Security)
      // If version changed (e.g. user clicked "Logout All" or changed password), deny access.
      if (user.refreshTokenVersion !== payload.ver) {
        throw new UnauthorizedException('Session invalidated');
      }

      // Validate Hash (Rotation Security)
      const isValid = await argon2.verify(user.refreshToken, refreshToken);
      if (!isValid) {
        // Token reuse detected! Potential theft. Invalidate user.
        await this.prisma.user.update({
          where: { id: user.id },
          data: { refreshToken: null },
        });
        throw new UnauthorizedException('Invalid refresh token');
      }

      // DETERMINE ORG CONTEXT (The "Smart" Logic)
      let targetOrgId = payload.orgId;

      // Scenario A: Token has an Org ID. Let's verify they are still a member.
      if (targetOrgId) {
        const membership = await this.prisma.organizationMember.findUnique({
          where: {
            organizationId_userId: { userId: user.id, organizationId: targetOrgId },
          },
          include: { organization: true } // Check if org is active
        });

        // If kicked out, or Org Suspended -> Fallback to NULL or another Org
        if (!membership || membership.organization.status !== 'ACTIVE') {
          targetOrgId = null; 
        }
      }

      // Scenario B: Target is NULL (either was null before, or we just set it to null)
      // Let's try to "Auto-Upgrade" them to their last active org or first available org.
      if (!targetOrgId) {
        // Try sticky session first
        if (user.lastActiveOrgId) {
             const sticky = await this.prisma.organizationMember.findFirst({
                 where: { userId: user.id, organizationId: user.lastActiveOrgId }
             });
             if (sticky) targetOrgId = user.lastActiveOrgId;
        }
        
        // If still null, just grab the first one they own/belong to
        if (!targetOrgId) {
            const fallback = await this.prisma.organizationMember.findFirst({
              where: { userId: user.id },
              orderBy: { role: { name: 'asc' } } // Prefer Owner roles? Or createdAt
            });
            if (fallback) targetOrgId = fallback.organizationId;
        }
      }

      // GENERATE & ROTATE
      
      const tokens = await this.generateTokens(
        user.id,
        user.email,
        targetOrgId, // Pass the resolved ID (can be null if still in onboarding)
        user.refreshTokenVersion, // KEEP VERSION SAME (Fixes multi-device issue)
      );

      // Rotate only the Refresh Token Hash
      await this.updateRefreshToken(user.id, tokens.refreshToken);

      // Update Activity Stats
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastActiveAt: new Date() }
      });

      return {
        user: this.toSafeUser(user as any),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        requiresEmailVerification: !user.isEmailVerified,
      };
    } catch (error) {
      // Don't expose internal errors to client, just say Unauthorized
      this.logger.warn(`Refresh failed: ${error.message}`);
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

  async handleSocialLogin(
    googleUser: {
      email: string;
      firstName: string;
      lastName: string;
      picture: string;
    },
    timezone: string,
  ) {
    try {
      const lowerEmail = googleUser.email.toLowerCase();

      //  Check if user exists
      let user = await this.prisma.user.findUnique({
        where: { email: lowerEmail },
        include: {
          systemRole: { select: { name: true } },
          lastActiveOrganization: { select: { id: true } },
          organizationMemberships: {
            where: { organization: { status: 'ACTIVE' } },
            take: 1,
            select: { organizationId: true },
          },
        },
      });

      //  If User exists, just log them in
      if (user) {
        // Determine active Org
        let activeOrgId =
          user.lastActiveOrganization?.id ||
          user.organizationMemberships[0]?.organizationId;

        if (!activeOrgId)
          throw new ForbiddenException(
            'User exists but has no active workspace.',
          );

        const tokens = await this.generateTokens(
          user.id,
          user.email,
          activeOrgId || null,
          user.refreshTokenVersion,
        );
        const refreshHash = await argon2.hash(tokens.refreshToken);

        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            refreshToken: refreshHash,
            lastActiveAt: new Date(),
            isEmailVerified: true,
            // If they didn't have an avatar, update it from Google
            avatar: user.avatar || googleUser.picture,
          },
        });

        return { user: this.toSafeUser(user), ...tokens };
      }

      // If User DOES NOT exist, Register them automatically
      // 3. NEW USER: Create User ONLY (No Organization)
      // This forces them into the "Pay to Create Org" flow.
      
      const systemRole = await this.prisma.role.findFirst({
        where: { name: 'user', scope: 'SYSTEM' },
      });

      const newUser = await this.prisma.user.create({
        data: {
          email: lowerEmail,
          password: await argon2.hash(crypto.randomBytes(32).toString('hex')), // Random password
          firstName: googleUser.firstName,
          lastName: googleUser.lastName,
          avatar: googleUser.picture,
          isEmailVerified: true, // Google verified it
          timezone,
          systemRoleId: systemRole.id,
          lastPasswordChange: new Date(),
          userType: 'INDIVIDUAL', // Default type
        },
        include: { systemRole: true } // Needed for toSafeUser
      });

      // Generate "Empty" Token (Org ID is NULL)
      const tokens = await this.generateTokens(
        newUser.id,
        newUser.email,
        null, // <--- IMPORTANT: No Org yet
        0,
      );
      
      const refreshHash = await argon2.hash(tokens.refreshToken);

      await this.prisma.user.update({
        where: { id: newUser.id },
        data: { refreshToken: refreshHash },
      });

      return { 
        user: this.toSafeUser(newUser), 
        ...tokens,
        organizationId: null 
      };
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException('Google login failed');
    }
  }

  async updateRefreshToken(userId: string, refreshToken: string): Promise<void> {
    const hash = await argon2.hash(refreshToken);

    //  Update the user record
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        refreshToken: hash,
      },
    });
  }

  private async generateTokens(
    userId: string,
    email: string,
    orgId: string,
    version: number,
  ) {
    const payload: JwtPayload = {
      sub: userId,
      email,
      orgId,
      ver: version,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_SECRET'),
        expiresIn: '7d',
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);

    return { accessToken, refreshToken };
  }


  private async generateVerificationToken(): Promise<{
    plainToken: string;
    hashedToken: string;
  }> {
    try {
      const plainToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = await argon2.hash(plainToken);
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
