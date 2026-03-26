import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';


@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Only decrypts if signed by the ADMIN secret
      secretOrKey: configService.get('JWT_SECRET'), 
    });
  }

  async validate(payload: any) {
    // 1. Fetch user to ensure they haven't been deleted or locked
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub, deletedAt: null },
      select: {
        id: true,
        email: true,
        userType: true,
        lockedUntil: true,
        refreshTokenVersion: true,
      },
    });

    // 2. Strict Security Checks
    if (!user) throw new UnauthorizedException();
    if (user.userType !== 'SUPER_ADMIN') throw new ForbiddenException('Admin access revoked');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new ForbiddenException('Admin account locked');
    if (payload.ver !== user.refreshTokenVersion) throw new UnauthorizedException('Session revoked');

    // 3. Return a clean, context-free payload
    return {
      userId: user.id,
      email: user.email,
      role: 'SUPER_ADMIN',
    };
  }
}