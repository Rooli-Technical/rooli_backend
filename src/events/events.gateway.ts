// src/events/events.gateway.ts
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
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
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

    this.logger.log(`Socket connected: ${client.id} user=${client.user.userId}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Socket disconnected: ${client.id}`);
  }

  // ---- Broadcast helpers (called by subscribers) ----

  emitToWorkspace(workspaceId: string, eventName: string, payload: any) {
    this.server.to(this.roomWorkspace(workspaceId)).emit(eventName, payload);
  }

  emitToConversation(workspaceId: string, conversationId: string, eventName: string, payload: any) {
    // You can choose to have clients join conversation rooms too.
    this.server.to(this.roomConversation(workspaceId, conversationId)).emit(eventName, payload);
  }

   emitToMember(memberId: string, eventName: string, payload: any) {
    this.server.to(this.roomMember(memberId)).emit(eventName, payload);
  }

  // ---- Optional client -> server events ----
  // Keep these tiny. Persisting read state should still be done via HTTP endpoint OR a dedicated service.

  @SubscribeMessage('join_conversation')
  handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { workspaceId: string; conversationId: string },
  ) {
    if (!client.user) return { ok: false };
    if (!client.user.workspaceIds.includes(body.workspaceId)) return { ok: false };

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
}
