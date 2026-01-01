import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
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
import { OnboardingDto } from './dtos/user-onboarding.dto';
import * as geoip from 'geoip-lite';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: MailService,
  ) {}

async register(registerDto: Register, ip: string) {
    const { email, password, firstName, lastName } = registerDto;
    const lowerEmail = email.toLowerCase();

    const geo = geoip.lookup(ip);
    let timezone = geo.timezone;

    const existingUser = await this.prisma.user.findUnique({
      where: { email: lowerEmail },
    });
    if (existingUser) throw new ConflictException('User already exists');

    const hashedPassword = await argon2.hash(password);

    // Create User 
    const newUser = await this.prisma.user.create({
      data: {
        email: lowerEmail,
        password: hashedPassword,
        firstName,
        lastName,
        timezone: timezone || 'Africa/Lagos',
        userType: 'INDIVIDUAL',
        isEmailVerified: false,
        systemRoleId: (await this.fetchSystemRole('user')).id,
      },
      include: { systemRole: true },
    });

    // Generate "Onboarding Token" (Org & Workspace are NULL)
    const tokens = await this.generateTokens(
      newUser.id,
      newUser.email,
      null, // No Org
      null, // No Workspace
      0,
    );

    await this.updateRefreshToken(newUser.id, tokens.refreshToken);

    this.resendVerificationEmail(lowerEmail).catch((e) => this.logger.error(e));

    return {
      user: this.toSafeUser(newUser),
      ...tokens,
      organizationId: null, // Signals frontend to redirect to /onboarding
      lastActiveWorkspaceId: null,
    };
  }

  async userOnboarding(userId: string, dto: OnboardingDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Check if they are already an OWNER of an organization
    const existingOwn = await this.prisma.organizationMember.findFirst({
      where: { userId: user.id, role: { name: 'owner' } },
    });
    if (existingOwn)
      throw new ConflictException('User already owns an organization');

    const orgName = dto.name;
    const workspaceName = dto.initialWorkspaceName || 'General';
    const orgSlug = await this.generateUniqueOrgSlug(orgName);

    // TRANSACTION: Create Org, Workspace, BrandKit, update User
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Update User Type
      if (dto.userType) {
        await tx.user.update({
          where: { id: userId },
          data: { userType: dto.userType },
        });
      }

      // 2. Fetch Roles inside transaction
      const ownerRole = await tx.role.findFirstOrThrow({ where: { name: 'owner', scope: 'ORGANIZATION' }});
      const adminRole = await tx.role.findFirstOrThrow({ where: { name: 'admin', scope: 'WORKSPACE' }});

      // 3. Create Org
      const org = await tx.organization.create({
        data: {
          name: orgName,
          slug: orgSlug,
          billingEmail: user.email,
          members: {
            create: {
              userId: user.id,
              roleId: ownerRole.id,
            },
          },
        },
      });

      // 4. Create Default Workspace
      const workspace = await tx.workspace.create({
        data: {
          name: workspaceName,
          slug: slugify(workspaceName, { lower: true }),
          organizationId: org.id,
          members: {
            create: {
              userId: user.id,
              roleId: adminRole.id,
            },
          },
        },
      });

      // 5. Create Brand Kit
      await tx.brandKit.create({
        data: { workspaceId: workspace.id, name: `${orgName} Brand Kit` },
      });

      // 6. Update User Context (Sticky Session)
      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: {
          lastActiveWorkspaceId: workspace.id,
          isOnboardingComplete: true,
        },
        include: { systemRole: true },
      });

      // 7. Generate NEW Tokens (Now containing the OrgID and WorkspaceID)
      const newTokens = await this.generateTokens(
        updatedUser.id,
        updatedUser.email,
        org.id,
        workspace.id,
        updatedUser.refreshTokenVersion,
      );

      // Save new refresh token
      await tx.user.update({
        where: { id: user.id },
        data: { refreshToken: await argon2.hash(newTokens.refreshToken) },
      });

      return {
        user: updatedUser,
        tokens: newTokens,
        workspaceId: workspace.id,
      };
    });

    return {
      user: this.toSafeUser(result.user),
      ...result.tokens,
      activeWorkspaceId: result.workspaceId,
    };
  }

  // ===========================================================================
  // 2. LOGIN & AUTH FLOWS
  // ===========================================================================

  async login(loginDto: Login) {
    const email = loginDto.email.toLowerCase();

    // 1. Fetch User (Include necessary relations for context resolution)
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      include: {
        systemRole: true,
        workspaceMemberships: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: { workspace: true },
        },
        organizationMemberships: {
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const validPass = await argon2.verify(user.password, loginDto.password);
    if (!validPass) throw new UnauthorizedException('Invalid credentials');

    // 2. Resolve Context (Sticky Session -> Fallback)
    const context = await this.resolveLoginContext(user);

    // 3. Generate Tokens
    const tokens = await this.generateTokens(
      user.id,
      user.email,
      context.orgId,
      context.workspaceId,
      user.refreshTokenVersion,
    );

    // 4. Update Activity
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastActiveAt: new Date(),
        lastActiveWorkspaceId: context.workspaceId,
        refreshToken: await argon2.hash(tokens.refreshToken),
      },
    });

    return {
      ...tokens,
      user: this.toSafeUser(user),
      lastActiveWorkspaceId: context.workspaceId,
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
          systemRole: true,
          workspaceMemberships: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            include: { workspace: true },
          },
          organizationMemberships: {
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!user || !user.refreshToken)
        throw new UnauthorizedException('Access Denied');
      if (user.refreshTokenVersion !== payload.ver)
        throw new UnauthorizedException('Session invalidated');

      const isValid = await argon2.verify(user.refreshToken, refreshToken);
      if (!isValid) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { refreshToken: null },
        });
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Re-Resolve Context (In case they were removed from the org since last token)
      const context = await this.resolveLoginContext(user);

      const tokens = await this.generateTokens(
        user.id,
        user.email,
        context.orgId,
        context.workspaceId,
        user.refreshTokenVersion,
      );

      await this.updateRefreshToken(user.id, tokens.refreshToken);

      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastActiveAt: new Date(), lastActiveWorkspaceId: context.workspaceId },
      });

      return {
        user: this.toSafeUser(user),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        requiresEmailVerification: !user.isEmailVerified,
        lastActiveWorkspaceId: context.workspaceId,
      };
    } catch (error) {
      this.logger.warn(`Refresh failed: ${error.message}`);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async handleSocialLogin(googleUser: any, ip: string) {
    const lowerEmail = googleUser.email.toLowerCase();

      const geo = geoip.lookup(ip);
    let timezone = geo.timezone;
    
    // A. Check if user exists
    let user = await this.prisma.user.findUnique({
      where: { email: lowerEmail },
      include: {
        systemRole: true,
        workspaceMemberships: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            include: { workspace: true },
        },
        organizationMemberships: {
            take: 1,
            orderBy: { createdAt: 'desc' },
        },
      },
    });

    // B. EXISTING USER
    if (user) {
      const context = await this.resolveLoginContext(user);

      const tokens = await this.generateTokens(
        user.id,
        user.email,
        context.orgId,
        context.workspaceId,
        user.refreshTokenVersion,
      );

      await this.updateRefreshToken(user.id, tokens.refreshToken);
      
      // Update Avatar if missing
      if (!user.avatar) {
          await this.prisma.user.update({ where: { id: user.id }, data: { avatar: googleUser.picture }});
      }

      return {
        user: this.toSafeUser(user),
        ...tokens,
        lastActiveWorkspaceId: context.workspaceId,
      };
    }

    // C. NEW USER (Register Logic - No Org yet)
    const newUser = await this.prisma.user.create({
      data: {
        email: lowerEmail,
        password: await argon2.hash(crypto.randomBytes(32).toString('hex')),
        firstName: googleUser.firstName,
        lastName: googleUser.lastName,
        avatar: googleUser.picture,
        isEmailVerified: true,
        timezone,
        userType: 'INDIVIDUAL',
        systemRoleId: (await this.fetchSystemRole('user')).id,
      },
      include: { systemRole: true }
    });

    const tokens = await this.generateTokens(
      newUser.id,
      newUser.email,
      null,
      null,
      0,
    );
    await this.updateRefreshToken(newUser.id, tokens.refreshToken);

    return {
      user: this.toSafeUser(newUser),
      ...tokens,
      organizationId: null, // Force redirect to Onboarding
      activeWorkspaceId: null
    };
  }

  // ===========================================================================
  // 3. INVITATIONS
  // ===========================================================================

  async acceptInvite(token: string, data: { password?: string; firstName?: string; lastName?: string }) {
    const invite = await this.prisma.invitation.findUnique({
      where: { token },
    });

    if (!invite || invite.expiresAt < new Date()) {
      throw new BadRequestException('Invitation invalid or expired');
    }

    let user = await this.prisma.user.findUnique({
      where: { email: invite.email },
    });

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create User if New
      if (!user) {
        if (!data.password) throw new BadRequestException('Password required');
        const hashedPassword = await argon2.hash(data.password);
        user = await tx.user.create({
          data: {
            email: invite.email,
            password: hashedPassword,
            firstName: data.firstName,
            lastName: data.lastName,
            userType: 'INDIVIDUAL',
            isEmailVerified: true,
            systemRoleId: (await this.fetchSystemRole('user')).id,
          },
        });
      }

      // 2. Add to Organization
      const orgMember = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invite.organizationId,
            userId: user.id,
          },
        },
      });

      if (!orgMember) {
        let orgRoleId = invite.roleId;
        // If inviting to a workspace, give them basic MEMBER role in Org
        if (invite.workspaceId) {
          const defaultRole = await tx.role.findFirst({
            where: { name: 'member', scope: 'ORGANIZATION' },
          });
          orgRoleId = defaultRole.id;
        }

        await tx.organizationMember.create({
          data: {
            userId: user.id,
            organizationId: invite.organizationId,
            roleId: orgRoleId,
          },
        });
      }

      // 3. Add to Workspace (if applicable)
      if (invite.workspaceId) {
        const wsMember = await tx.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: invite.workspaceId,
              userId: user.id,
            },
          },
        });

        if (!wsMember) {
          await tx.workspaceMember.create({
            data: {
              userId: user.id,
              workspaceId: invite.workspaceId,
              roleId: invite.roleId,
            },
          });
        }
      }

      // 4. Delete Invite
      await tx.invitation.delete({ where: { id: invite.id } });

      return user;
    });

    // 5. Generate Token (With the specific workspace context they just joined)
    return this.generateTokens(
      result.id,
      result.email,
      invite.organizationId,
      invite.workspaceId || null, // If invited to Org only, this is null
      0,
    );
  }

  // ===========================================================================
  // 4. HELPERS (The "Glue" Code)
  // ===========================================================================

  /**
   * Centralized Logic to determine "Where should this user land?"
   * 1. Try Sticky Session (Last Active Workspace)
   * 2. Fallback to Most Recent Workspace
   * 3. Fallback to Organization (if Billing Admin)
   */
  private async resolveLoginContext(user: any) {
    let activeWorkspaceId = user.lastActiveWorkspaceId;
    let activeOrgId: string | null = null;

    // A. Verify Sticky Session
    if (activeWorkspaceId) {
      const stickyMember = await this.prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: activeWorkspaceId,
            userId: user.id,
          },
        },
        select: { workspace: { select: { organizationId: true } } },
      });

      if (stickyMember) {
        activeOrgId = stickyMember.workspace.organizationId;
      } else {
        activeWorkspaceId = null; // Stale
      }
    }

    // B. Fallback: Any Workspace
    if (!activeWorkspaceId && user.workspaceMemberships?.length > 0) {
      const fallback = user.workspaceMemberships[0];
      activeWorkspaceId = fallback.workspaceId;
      activeOrgId = fallback.workspace.organizationId;
    }

    // C. Fallback: Any Org (Billing Admin)
    if (!activeOrgId && user.organizationMemberships?.length > 0) {
      activeOrgId = user.organizationMemberships[0].organizationId;
    }

    return { orgId: activeOrgId, workspaceId: activeWorkspaceId };
  }

  private async generateTokens(
    userId: string,
    email: string,
    orgId: string | null,
    workspaceId: string | null, // Added this!
    version: number,
  ) {
    const payload: JwtPayload = {
      sub: userId,
      email,
      orgId,
      workspaceId, // Frontend uses this to redirect immediately
      ver: version,
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

  async updateRefreshToken(userId: string, refreshToken: string): Promise<void> {
    const hash = await argon2.hash(refreshToken);
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: hash },
    });
  }

  private async fetchSystemRole(name: string) {
    const role = await this.prisma.role.findFirst({
      where: { name, scope: 'SYSTEM' },
    });
    if (!role)
      throw new InternalServerErrorException(`System Role '${name}' not found`);
    return role;
  }

  private async generateUniqueOrgSlug(name: string): Promise<string> {
    const baseSlug = slugify(name, { lower: true, strict: true });
    let slug = baseSlug;
    let count = 1;
    while (await this.prisma.organization.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${count++}`;
    }
    return slug;
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
      isEmailVerified: user.isEmailVerified,
      lastActiveAt: user.lastActiveAt,
      userType: user.userType
    };
  }

  //@Cron(CronExpression.EVERY_WEEK)
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
