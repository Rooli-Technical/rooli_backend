import { Global, Logger, Module } from '@nestjs/common';
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
          return { host: 'localhost', port: 6379 };
        }

        const url = new URL(redisUrl);

        // IMPORTANT: Render Internal URLs (redis://) do NOT use TLS.
        // External URLs (rediss://) DO use TLS.
        const isInternal = !redisUrl.startsWith('rediss://');

        return {
          host: url.hostname,
          port: Number(url.port),
          username: url.username ? decodeURIComponent(url.username) : undefined,
          password: url.password ? decodeURIComponent(url.password) : undefined,
          // Only apply TLS if it's an external connection
          ...(isInternal ? {} : { tls: { rejectUnauthorized: false } }),
          keepAlive: 10000,
          connectTimeout: 10000,
        };
      },
    },

    {
      provide: 'REDIS_CLIENT',
      inject: ['REDIS_OPTIONS'],
      useFactory: (options) => {
        const logger = new Logger('RedisClient');

        const client = new Redis({
          ...options,
          maxRetriesPerRequest: null, // Required for BullMQ
          enableReadyCheck: true, // Set to true to ensure stable connection before use

          // This prevents the "Connection Burst" that causes ECONNRESET
          retryStrategy: (times) => {
            const delay = Math.min(times * 100, 3000);
            return delay;
          },
          reconnectOnError: (err) => {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) return true;
            return false;
          },
        });

        client.on('error', (err: NodeJS.ErrnoException) => {
          // Silent ECONNRESET logs to keep your terminal clean,
          // ioredis handles the reconnect automatically.
          if (err.code === 'ECONNRESET') {
            logger.warn('Redis connection reset. Retrying...');
          } else {
            logger.error(`Redis Error: ${err.message}`);
          }
        });

        client.on('connect', () => logger.log('Redis connected!'));

        return client;
      },
    },
  ],
  exports: ['REDIS_CLIENT', 'REDIS_OPTIONS', RedisService],
})
export class RedisModule {}
