import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { WorkerModule } from './worker/worker.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    // 1. CONFIGURATION (Copied from AppModule)
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // 2. DATABASE (Essential for your processors)
    PrismaModule,

    BullModule.forRootAsync({
      inject: ['REDIS_OPTIONS', 'REDIS_CLIENT'], // Inject your existing client to steal its listener logic
      useFactory: (redisOptions, redisClient) => ({
        connection: {
          ...redisOptions,
          // BullMQ needs to know how to handle connection errors internally
          reconnectOnError: (err) => {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) {
              return true;
            }
            return false;
          },
        },
        defaultJobOptions: {
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        },
      }),
    }),
    RedisModule,
    // 4. THE LOGIC (Your existing module)
    WorkerModule,
  ],
})
export class WorkerAppModule {}
