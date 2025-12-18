import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        systemRole: {
          select: { name: true, id: true },
        },
        isEmailVerified: true,
        lockedUntil: true,
        lastPasswordChange: true,
        refreshTokenVersion: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException();
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException('Account is locked');
    }

    // Check token version (Instant Revocation)
    if (payload.ver !== user.refreshTokenVersion) {
      throw new UnauthorizedException('Session has been revoked');
    }

    if (user.lastPasswordChange) {
      const passwordChangedTime = user.lastPasswordChange.getTime() / 1000;
      // If token was issued BEFORE the last password change, reject it
      if (payload.iat < passwordChangedTime) {
        throw new UnauthorizedException('Password changed, please login again');
      }
    }

    return {
      ...user,
      orgId: payload.orgId, 
    };
  }
}
