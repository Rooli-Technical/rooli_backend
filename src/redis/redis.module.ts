import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { RedisController } from './redis.controller';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    RedisService,
    {
      provide: 'REDIS_OPTIONS',
      useFactory: () => {
        const redisUrl = process.env.REDIS_URL;

        if (!redisUrl) {
          return {
            host: 'localhost',
            port: 6379,
          };
        }

        const url = new URL(redisUrl);
        const isTls = redisUrl.startsWith('rediss://');

        return {
          host: url.hostname,
          port: Number(url.port),
          username: url.username ? decodeURIComponent(url.username) : undefined,
          password: url.password ? decodeURIComponent(url.password) : undefined,
          ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
        };
      },
    },

    {
      provide: 'REDIS_CLIENT',
      inject: ['REDIS_OPTIONS'],
      useFactory: (options) => {
        const client = new Redis({
          ...options,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        });

        client.on('error', (err) => {
          console.error('Redis error:', err.message);
        });

        return client;
      },
    },
  ],
  exports: ['REDIS_CLIENT', 'REDIS_OPTIONS', RedisService],
})
export class RedisModule {}