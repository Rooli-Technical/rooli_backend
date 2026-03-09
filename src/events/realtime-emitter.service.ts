import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';

@Injectable()
export class RealtimeEmitterService implements OnModuleInit {
  private emitter: Emitter;
  private readonly logger = new Logger(RealtimeEmitterService.name);

  async onModuleInit() {
    try {
      // 1. ioredis connects automatically
      const client = new Redis(process.env.REDIS_URL as string);
      
      // 2. Wait for it to be fully ready
      await new Promise<void>((resolve) => client.on('ready', resolve));
      
      // 3. Bind the emitter
      this.emitter = new Emitter(client);
      this.logger.log('Realtime Emitter successfully connected to Redis');
    } catch (error) {
      this.logger.error('Failed to connect Realtime Emitter to Redis', error);
    }
  }

  // --- Your Broadcasting Methods ---

  emitToWorkspace(workspaceId: string, event: string, payload: any) {
    if (!this.emitter) return;
    this.emitter.to(`workspace:${workspaceId}`).emit(event, payload);
  }

  emitToConversation(workspaceId: string, conversationId: string, event: string, payload: any) {
    if (!this.emitter) return;
    this.emitter.to(`workspace:${workspaceId}:conversation:${conversationId}`).emit(event, payload);
  }

  emitToMember(memberId: string, event: string, payload: any) {
    if (!this.emitter) return;
    this.emitter.to(`member:${memberId}`).emit(event, payload);
  }
}