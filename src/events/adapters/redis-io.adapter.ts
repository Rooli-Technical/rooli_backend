import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis'; 

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  async connectToRedis(): Promise<void> {
    // ioredis connects automatically upon instantiation
    const pubClient = new Redis(process.env.REDIS_URL as string);
    const subClient = pubClient.duplicate();

    // Wait for both clients to establish a ready connection to Redis
    await Promise.all([
      new Promise<void>((resolve) => pubClient.on('ready', resolve)),
      new Promise<void>((resolve) => subClient.on('ready', resolve)),
    ]);

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    
    // Attach the Redis adapter to the Socket.io server
    server.adapter(this.adapterConstructor);
    
    return server;
  }
}