import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { INestApplicationContext } from '@nestjs/common';
import Redis from 'ioredis';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  // Accept the existing pubClient from main.ts
  constructor(app: INestApplicationContext, private readonly pubClient: Redis) {
    super(app);
    console.log('✅ RedisIoAdapter is ALIVE');
  }

  async connectToRedis(): Promise<void> {
  const subClient = this.pubClient.duplicate();

  // 1. Error handling (Essential for Render's 50-conn limit)
  subClient.on('error', (err) => {
    console.warn('[RedisIoAdapter] subClient connection reset:', err.message);
  });

  // 2. Wait for both clients to be "Ready"
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        if (this.pubClient.status === 'ready') return resolve();
        this.pubClient.once('ready', resolve);
        this.pubClient.once('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        if (subClient.status === 'ready') return resolve();
        subClient.once('ready', resolve);
        subClient.once('error', reject);
      }),
    ]);
    console.log('🔌 Redis clients are READY');
  } catch (err: any) {
    console.error('❌ Redis Adapter failed to reach "ready" status:', err.message);
    return; // Don't try to subscribe if the connection failed
  }

  // 3. Setup the Pattern Listener
  subClient.on('pmessage', (pattern, channel, message) => {
    // This confirms the API HEARD the worker's broadcast
    console.log(`📥 [Redis -> Web API] Received event on channel: ${channel}`);
  });

  // 4. Actively subscribe to the Socket.io pattern
  try {
    await subClient.psubscribe('socket.io#*'); 
    console.log('📡 [RedisIoAdapter] Subscribed to socket.io#* channels');
  } catch (e) {
    console.error('❌ Failed to psubscribe to Redis channels', e);
  }

  this.adapterConstructor = createAdapter(this.pubClient, subClient);
}


  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}