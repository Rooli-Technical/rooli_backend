import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

import type { WsAuthedUser } from './events.gateway';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Socket.io middleware:
 * - Validates JWT from auth header OR query token
 * - Loads user's workspace memberships from DB
 * - Attaches client.user = { userId, workspaceIds }
 *
 * IMPORTANT: keep this fast. Select only what you need.
 */
@Injectable()
export class WsAuthMiddleware {
  private readonly logger = new Logger(WsAuthMiddleware.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  use = async (client: Socket, next: (err?: any) => void) => {
    try {
      console.log('WS Auth Middleware: New connection, authenticating...');
      const token = this.extractToken(client);
      if (!token) return next(new Error('Unauthorized'));

      // Your JWT payload shape may differ. Common: { sub: userId }
      const payload: any = await this.jwt.verifyAsync(token);
      const userId: string | undefined =
        payload?.sub ?? payload?.userId ?? payload?.id;
      if (!userId) return next(new Error('Unauthorized'));

      // Load memberships
      const memberships = await this.prisma.workspaceMember.findMany({
        where: {
          member: {
            userId: userId,
          },
        },
        select: {
          id: true,
          workspaceId: true,
        },
      });
      // For now, pick "current" member as the one on the workspace you connect to.
      // If your UI connects per selected workspace, pass workspaceId in handshake query.
      const memberId = memberships[0]?.id;

      const user: WsAuthedUser = {
        userId,
        memberId,
        workspaceIds: memberships.map((m) => m.workspaceId),
      };

      client.user = user;
      return next();
    } catch (e: any) {
      this.logger.warn(`WS auth failed: ${e?.message ?? String(e)}`);
      return next(new Error('Unauthorized'));
    }
  };

  private extractToken(client: Socket): string | null {
    const authHeader = client.handshake.headers['authorization'];

    if (authHeader && typeof authHeader === 'string') {
      const parts = authHeader.split(' ');
      if (parts.length === 2) {
        const [type, token] = parts;
        if (type.toLowerCase() === 'bearer' && token) {
          return token.trim();
        }
      }
    }

    // 2) Fallback to Socket.io Auth object
    const authObj = client.handshake.auth?.token;
    if (authObj && typeof authObj === 'string') {
      return authObj.trim();
    }

    const queryToken = client.handshake.query?.token;
    if (typeof queryToken === 'string' && queryToken.trim())
      return queryToken.trim();

    return null;
  }
}
