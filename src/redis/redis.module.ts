import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { RedisController } from './redis.controller';
import Redis from 'ioredis';

@Global()
@Module({
  controllers: [RedisController],
  providers: [
    RedisService,

    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        if (process.env.REDIS_URL) {
          console.log('🚀 Connecting to Cloud Redis...');
          return new Redis(process.env.REDIS_URL, {
            tls: { rejectUnauthorized: false },
          });
        }

        console.log('💻 Connecting to Local Redis...');
        return new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
        });
      },
    },
  ],
  // 2. NOW you can export it
  exports: [RedisService, 'REDIS_CLIENT'],
})
export class RedisModule {}
