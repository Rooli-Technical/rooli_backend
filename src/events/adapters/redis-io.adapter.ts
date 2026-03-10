import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { INestApplicationContext } from '@nestjs/common';
import Redis from 'ioredis';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private readonly subClient: Redis;

  constructor(app: INestApplicationContext, private readonly pubClient: Redis) {
    super(app);
    this.subClient = this.pubClient.duplicate();
    // 1. Always initialize this factory immediately in the constructor
    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
  }

  async connectToRedis(): Promise<void> {
    const handleError = (name: string) => (err: any) => {
      console.error(`[RedisIoAdapter] ${name} error:`, err.message);
    };

    this.pubClient.on('error', handleError('pubClient'));
    this.subClient.on('error', handleError('subClient'));

    try {
      // 2. Ensuring readiness before app.listen() prevents "lost" initial events
      await Promise.all([
        this.waitForReady(this.pubClient, 'pubClient'),
        this.waitForReady(this.subClient, 'subClient'),
      ]);
      console.log('🔌 Redis clients are READY');
      
      // Note: Removed manual psubscribe to avoid conflict with the adapter's internal logic.
    } catch (err: any) {
      console.error('❌ Redis Connection Failed:', err.message);
      throw err;
    }
  }

  private waitForReady(client: Redis, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (client.status === 'ready') return resolve();
      client.once('ready', resolve);
      client.once('error', (err) => reject(new Error(`${name}: ${err.message}`)));
    });
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
