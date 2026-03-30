import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { isIPInRange, normalizeIp } from '@/admin/utils';
import { Request } from 'express';

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
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: any) {
    const currentSession = await this.prisma.adminSession.findFirst({
      where: {
        id: payload?.sessionId,
      },
    });

    if (!currentSession || !currentSession?.isActive) {
      throw new UnauthorizedException(
        "Your session is either revoked or doesn't exist, contact admin",
      );
    }
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

    // 🔒 IP Whitelist Check
    const rawIp =
      req.ip ?? req.headers['x-forwarded-for']?.toString().split(',')[0].trim();
    const requestIp = normalizeIp(rawIp);
    const whitelist = await this.prisma.ipWhitelist.findMany({
      where: { adminId: user.id },
      select: { ipRange: true },
    });

    // If whitelist is configured, enforce it
    if (whitelist.length > 0) {
      const isAllowed = whitelist.some(({ ipRange }) =>
        isIPInRange(requestIp, ipRange),
      );

      if (!isAllowed) {
        throw new ForbiddenException('Access denied from this IP address');
      }
    }

    // 2. Strict Security Checks
    if (!user) throw new UnauthorizedException();
    if (user.userType !== 'SUPER_ADMIN')
      throw new ForbiddenException('Admin access revoked');
    if (user.lockedUntil && user.lockedUntil > new Date())
      throw new ForbiddenException('Admin account locked');
    if (payload.ver !== user.refreshTokenVersion)
      throw new UnauthorizedException('Session revoked');

    // 3. Return a clean, context-free payload
    return {
      userId: user.id,
      email: user.email,
      role: 'SUPER_ADMIN',
      sessionId: payload.sessionId,
    };
  }
}
