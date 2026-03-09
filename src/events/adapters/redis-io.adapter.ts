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
    // Socket.io requires a separate client for subscribing, so we duplicate the one you passed in.
    // .duplicate() automatically copies the TLS settings from your RedisModule!
    const subClient = this.pubClient.duplicate();

    await Promise.all([
      new Promise<void>((resolve) => {
        if (this.pubClient.status === 'ready') return resolve();
        this.pubClient.on('ready', resolve);
      }),
      new Promise<void>((resolve) => subClient.on('ready', resolve)),
    ]);

    this.adapterConstructor = createAdapter(this.pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}