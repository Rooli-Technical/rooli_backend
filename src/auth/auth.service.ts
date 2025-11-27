import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
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
import { Prisma, User } from '@generated/client';
import { UserRole } from '@generated/enums';
import * as argon2 from 'argon2';
import { handlePrismaError } from '@/common/prisma.utils';
import { Cron, CronExpression } from '@nestjs/schedule';

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

  async register(registerDto: Register): Promise<AuthResponse> {
    const { email, password, firstName, lastName, role } = registerDto;

    // Validate password strength before DB work
    this.validatePasswordStrength(password);

    const hashedPassword = await argon2.hash(password);
    const { plainToken, hashedToken } = await this.generateVerificationToken();

    try {
      const user = await this.prisma.user.create({
        data: {
          email: email.toLowerCase(),
          password: hashedPassword,
          firstName: firstName?.trim(),
          lastName: lastName?.trim(),
          role: role || UserRole.ANALYST,
          emailVerificationToken: hashedToken,
          emailVerificationSentAt: new Date(),
          lastPasswordChange: new Date(),
        },
      });

      const tokens = await this.generateTokens(user);

      const refreshHash = await argon2.hash(tokens.refreshToken);
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          refreshToken: refreshHash,
          refreshTokenVersion: 0, // Initialize version
        },
      });

      // this.sendVerificationEmail(user.email, plainToken).catch((err) => {
      //   this.logger.error('Failed to send verification email (fallback)', {
      //     userId: user.id,
      //     email: user.email,
      //     error: err?.message,
      //   });
      // });

      this.logger.log(`New user registered: ${user.email}`);
      return {
        user: this.toSafeUser(user),
        ...tokens,
        requiresEmailVerification: !user.isEmailVerified,
      };
    } catch (err) {
      // If unique constraint triggered, check if it's a soft-deleted user to restore
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // find existing user to determine if deletedAt is set
        const existingUser = await this.prisma.user.findUnique({
          where: { email: email.toLowerCase() },
          select: { id: true, deletedAt: true },
        });

        if (existingUser?.deletedAt) {
          // restore path (this will re-hash password and return tokens)
          return this.restoreUser(existingUser.id, password);
        }

        throw new ConflictException('User already exists');
      }

      handlePrismaError(err);
    }
  }

  async login(loginDto: Login): Promise<AuthResponse> {
    try{
    const email = loginDto.email.toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: {
        email,
        deletedAt: null,
      },
    });

    if (!user) {
      await this.simulateProcessingDelay();
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException(
        `Account temporarily locked. Try again at ${user.lockedUntil.toISOString()}`,
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

    // Reset security counters and return the updated user (select updated fields)
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        loginAttempts: 0,
        lockedUntil: null,
        lastActiveAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatar: true,
        role: true,
        isEmailVerified: true,
        lastActiveAt: true,
        refreshToken: true,
      },
    });

    // generate tokens
    const { accessToken, refreshToken } = await this.generateTokens(
      updatedUser as any,
    );

    // store hashed refresh token (single refresh token per-user approach)
    const refreshHash = await argon2.hash(refreshToken);
    await this.prisma.user.update({
      where: { id: updatedUser.id },
      data: {
        refreshToken: refreshHash,
      },
    });

    this.logger.log(`User logged in: ${updatedUser.email}`);

    return {
      user: this.toSafeUser(updatedUser as any),
      accessToken,
      refreshToken,
      requiresEmailVerification: !updatedUser.isEmailVerified,
    };
  }catch(err){
    this.logger.error(err)
    throw err
  }
  }

  async refreshTokens(refreshToken: string): Promise<AuthResponse> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
      });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub, deletedAt: null },
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
        this.logger.warn('Invalid refresh token attempt', { userId: user.id });
        throw new UnauthorizedException('Invalid refresh token');
      }

      const tokens = await this.generateTokens(user);
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
    try{
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
  }catch(err){
    throw err
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
    try{
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
  }catch(err){
    this.logger.error(err)
    throw err
  }
  }

  async logout(userId: string): Promise<void> {
    try{
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        refreshToken: null,
        lastActiveAt: new Date(),
      },
    });

    this.logger.log(`User logged out: ${userId}`);
  }catch(err){
     this.logger.error(err)
    throw err
  }
  }

  async resendVerificationEmail(email: string): Promise<void> {
    try{
    const user = await this.prisma.user.findFirst({
      where: {
        email: email.toLowerCase(),
        deletedAt: null,
        isEmailVerified: false,
      },
    });

    if (!user) return; // Silent fail for security

    const { plainToken, hashedToken } = await this.generateVerificationToken();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationToken: hashedToken,
        emailVerificationSentAt: new Date(),
      },
    });

    this.sendVerificationEmail(user.email, plainToken);
  }catch(err){
     this.logger.error(err)
    throw err
  }
  }

  private async generateTokens(user: User) {
    try{
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      ver: user.refreshTokenVersion || 0,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_SECRET'),
        expiresIn: this.configService.get('JWT_EXPIRES_IN', '7d'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN', '7d'),
      }),
    ]);

    return { accessToken, refreshToken };
  }catch(err){
     this.logger.error(err)
    throw err
  }
  }

  private async handleFailedLogin(userId: string): Promise<void> {
    try{
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
  }catch(err){
     this.logger.error(err)
    throw err
  }
  }

  private async generateVerificationToken(): Promise<{
    plainToken: string;
    hashedToken: string;
  }> {
    try{
    const plainToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = await argon2.hash(plainToken);
    console.log(plainToken);
    return { plainToken, hashedToken };
    }catch(err){
     this.logger.error(err)
    throw err
  }
  }

  private validatePasswordStrength(password: string): void {
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

  private async restoreUser(
    userId: string,
    newPassword: string,
  ): Promise<AuthResponse> {
    this.validatePasswordStrength(newPassword);
    const hashedPassword = await argon2.hash(newPassword);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        deletedAt: null,
        loginAttempts: 0,
        lockedUntil: null,
        lastActiveAt: new Date(),
        lastPasswordChange: new Date(),
      },
    });

    const tokens = await this.generateTokens(user);
    this.logger.log(`Restored previously deleted user: ${user.email}`);

    return {
      user: this.toSafeUser(user),
      ...tokens,
      requiresEmailVerification: !user.isEmailVerified,
    };
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

  private toSafeUser(user: User): SafeUser {
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
