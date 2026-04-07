import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { WsAuthMiddleware } from './ws-auth.middleware';

export type WsAuthedUser = {
  userId: string;
  memberId?: string;
  workspaceIds: string[];
  // optionally: memberId, roles, etc.
};

declare module 'socket.io' {
  interface Socket {
    user?: WsAuthedUser;
  }
}

/**
 * Strictly handles Socket.io I/O.
 * - No Prisma
 * - No business logic
 * - Join rooms, broadcast events, accept small client events (read, typing) if you want.
 */
@WebSocketGateway({
  namespace: '/events',
  cors: { origin: true, credentials: true },
  transports: ['websocket'],
})
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly wsAuthMiddleware: WsAuthMiddleware) {}

  afterInit(server: Server) {
    server.use(this.wsAuthMiddleware.use);
    this.logger.log('WebSocket Gateway Initialized with Auth Middleware');
  }

  async handleConnection(client: Socket) {
    // ws-auth.middleware sets client.user
    if (!client.user) {
      this.logger.warn(`Unauthed socket blocked: ${client.id}`);
      client.disconnect(true);
      return;
    }

    // Join workspace rooms (server-authoritative)
    for (const wid of client.user.workspaceIds) {
      client.join(this.roomWorkspace(wid));
    }

    client.join(this.roomMember(client.user.memberId));

    this.logger.log(
      `Socket connected: ${client.id} user=${client.user.userId}`,
    );
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('join_conversation')
  handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { workspaceId: string; conversationId: string },
  ) {
    if (!client.user) return { ok: false };
    if (!client.user.workspaceIds.includes(body.workspaceId))
      return { ok: false };

    client.join(this.roomConversation(body.workspaceId, body.conversationId));
    return { ok: true };
  }

  @SubscribeMessage('leave_conversation')
  handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { workspaceId: string; conversationId: string },
  ) {
    if (!client.user) return { ok: false };
    client.leave(this.roomConversation(body.workspaceId, body.conversationId));
    return { ok: true };
  }

  private roomWorkspace(workspaceId: string) {
    return `workspace:${workspaceId}`;
  }

  private roomConversation(workspaceId: string, conversationId: string) {
    return `workspace:${workspaceId}:conversation:${conversationId}`;
  }

  private roomMember(memberId: string) {
    return `member:${memberId}`;
  }

  @SubscribeMessage('join:ticket')
  handleJoinTicket(client: Socket, payload: { ticketId: string }) {
    const room = `ticket:${payload.ticketId}`;
    client.join(room);
    this.logger.log(`✅ Client ${client.id} joined room: ${room}`);
    this.logger.log(`📋 Client rooms: ${[...client.rooms].join(', ')}`);
    return { joined: room }; // 👈 sends ack back to client
  }

  @SubscribeMessage('leave:ticket')
  handleLeaveTicket(client: Socket, payload: { ticketId: string }) {
    const room = `ticket:${payload.ticketId}`;
    client.leave(room);
    this.logger.log(`👋 Client ${client.id} left room: ${room}`);
    return { left: room }; 
  }
}
