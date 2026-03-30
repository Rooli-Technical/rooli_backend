import { Injectable, OnModuleInit, Logger, Inject } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';

@Injectable()
export class RealtimeEmitterService implements OnModuleInit {
  private emitter: Emitter;
  private readonly logger = new Logger(RealtimeEmitterService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Redis) {}

  async onModuleInit() {
    try {
      // The RedisModule already handles connections and TLS.
      // We just pass the client directly into the Emitter.
      this.emitter = new Emitter(this.redisClient);
      this.logger.log(
        'Realtime Emitter successfully connected to Redis via global RedisModule',
      );
    } catch (error) {
      this.logger.error('Failed to initialize Realtime Emitter', error);
    }
  }

  emitToWorkspace(workspaceId: string, event: string, payload: any) {
    if (!this.emitter) {
      this.logger.error(
        `❌ Emitter not initialized. Failed to broadcast ${event}`,
      );
      return;
    }

    const room = `workspace:${workspaceId}`;
    // Add this line:
    this.logger.debug(`📡 [Worker -> Redis] Emitting ${event} to room ${room}`);

    this.emitter.of('/events').to(room).emit(event, payload);
  }

  emitToTicketId(ticketId: string, event: string, payload: any) {
    if (!this.emitter) {
      this.logger.error(
        `❌ Emitter not initialized. Failed to broadcast ${event}`,
      );
      return;
    }

    const room = `ticket:${ticketId}`;
    // Add this line:
    this.logger.debug(`📡 [Worker -> Redis] Emitting ${event} to room ${room}`);

    this.emitter.of('/events').to(room).emit(event, payload);
  }

  emitToConversation(
    workspaceId: string,
    conversationId: string,
    event: string,
    payload: any,
  ) {
    if (!this.emitter) return;
    this.emitter
      .of('/events')
      .to(`workspace:${workspaceId}:conversation:${conversationId}`)
      .emit(event, payload);
  }

  emitToMember(memberId: string, event: string, payload: any) {
    if (!this.emitter) return;
    this.emitter.of('/events').to(`member:${memberId}`).emit(event, payload);
  }
}
