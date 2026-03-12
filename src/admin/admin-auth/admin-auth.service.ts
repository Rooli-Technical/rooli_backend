import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async handleAdminGoogleLogin(googleUser: any) {
    const lowerEmail = googleUser.email.toLowerCase();

    // 1. Find the user and ENSURE they are explicitly marked as an admin
    const user = await this.prisma.user.findUnique({
      where: { email: lowerEmail },
    });

    if (!user || user.userType !== 'SUPER_ADMIN') {
      this.logger.warn(`Failed admin login attempt for ${lowerEmail}`);
      throw new UnauthorizedException('Access denied: Not a system administrator');
    }

    // 2. Generate Admin-Specific Tokens
    return this.generateAdminTokens(user.id, user.email, user.refreshTokenVersion);
  }

  private async generateAdminTokens(userId: string, email: string, version: number) {
    const payload = { sub: userId, email, ver: version, role: 'SUPER_ADMIN' };

    // Notice we use different environment variables for the secrets
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('ADMIN_JWT_SECRET'),
        expiresIn: '1h', // Shorter expiry for admins is safer
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('ADMIN_JWT_REFRESH_SECRET'),
        expiresIn: '24h', 
      }),
    ]);

    return { accessToken, refreshToken };
  }
}
