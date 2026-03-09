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
  }

  async connectToRedis(): Promise<void> {
  const subClient = this.pubClient.duplicate();

  // 1. ADD THIS: This prevents the log-only ECONNRESET from crashing the process
  subClient.on('error', (err) => {
    // We log it as a warning since ioredis will auto-reconnect anyway
    console.warn('[RedisIoAdapter] subClient connection reset:', err.message);
  });

  // 2. Wrap the ready check in a try/catch to ensure it doesn't hang your startup
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
  } catch (err: any) {
    console.error('Redis Adapter failed to reach "ready" status:', err.message);
  }

  this.adapterConstructor = createAdapter(this.pubClient, subClient);
}

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}