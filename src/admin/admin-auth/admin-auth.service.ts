import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import * as argon2 from 'argon2';

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async login(email: string, password: string, ip: string) {
    const lowerEmail = email.toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email: lowerEmail, deletedAt: null },
      select: {
        id: true,
        email: true,
        password: true,
        userType: true,
        lockedUntil: true,
        loginAttempts: true,
        refreshTokenVersion: true,
        firstName: true,
        lastName: true,
      },
    });

    // Generic error — don't reveal whether the email exists
    if (!user || !user.password) {
      this.logger.warn(`Failed admin login attempt for ${lowerEmail}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Only SUPER_ADMINs allowed
    if (user.userType !== 'SUPER_ADMIN') {
      this.logger.warn(
        `Non-admin login attempt on admin route for ${lowerEmail}`,
      );
      throw new ForbiddenException('Access denied: Not a system administrator');
    }

    // Check account lock
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException(
        `Account locked until ${user.lockedUntil.toISOString()}`,
      );
    }

    // Verify password

    const isPasswordValid = await argon2.verify(user.password, password);

    if (!isPasswordValid) {
      const attempts = user.loginAttempts + 1;
      const shouldLock = attempts >= 5;

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          loginAttempts: attempts,
          ...(shouldLock
            ? { lockedUntil: new Date(Date.now() + 30 * 60 * 1000) }
            : {}),
        },
      });

      this.logger.warn(
        `Failed admin login for ${lowerEmail} — attempt ${attempts}/5`,
      );

      if (shouldLock) {
        throw new ForbiddenException(
          'Account locked for 30 minutes due to too many failed attempts',
        );
      }

      throw new UnauthorizedException('Invalid credentials');
    }

    // Reset on success
    await this.prisma.user.update({
      where: { id: user.id },
      data: { loginAttempts: 0, lockedUntil: null, lastActiveAt: new Date() },
    });

    this.logger.log(`Admin login successful for ${lowerEmail}`);

    // Delete Existing sessions
    await this.prisma.adminSession.deleteMany({
      where: {
        adminId: user.id,
      },
    });
    // Create a new token

    const session = await this.prisma.adminSession.create({
      data: {
        adminId: user.id,
        ip: ip, // pass ip from the controller
        isActive: true,
      },
    });

    const tokens = await this.generateAdminTokens(
      user.id,
      user.email,
      user.refreshTokenVersion,
      session.id,
    );

    // After generateAdminTokens()

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: 'SUPER_ADMIN',
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GOOGLE LOGIN  (existing — untouched)
  // ─────────────────────────────────────────────────────────────────────────

  async handleAdminGoogleLogin(googleUser: any, ip: string = 'unknown') {
    const lowerEmail = googleUser.email.toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email: lowerEmail },
    });

    if (!user || user.userType !== 'SUPER_ADMIN') {
      this.logger.warn(`Failed admin login attempt for ${lowerEmail}`);
      throw new UnauthorizedException(
        'Access denied: Not a system administrator',
      );
    }

    const session = await this.prisma.adminSession.create({
      data: { adminId: user.id, ip, isActive: true },
    });

    return this.generateAdminTokens(
      user.id,
      user.email,
      user.refreshTokenVersion,
      session.id,
    );
  }

  async logout(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        refreshToken: null,
        refreshTokenVersion: { increment: 1 },
      },
    });

    this.logger.log(`Admin logout for userId: ${userId}`);
    return { message: 'Logged out successfully' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TOKEN GENERATION  (existing — untouched)
  // ─────────────────────────────────────────────────────────────────────────

  private async generateAdminTokens(
    userId: string,
    email: string,
    version: number,
    sessionId: string,
  ) {
    const payload = {
      sub: userId,
      email,
      ver: version,
      role: 'SUPER_ADMIN',
      sessionId: sessionId,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_SECRET'),
        expiresIn: '1h',
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
        expiresIn: '24h',
      }),
    ]);

    return { accessToken, refreshToken };
  }
}
