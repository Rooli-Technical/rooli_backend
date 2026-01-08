import { Module } from '@nestjs/common';
import { WorkerService } from './worker.service';
import { WorkerController } from './worker.controller';

@Module({
  imports: [
    BullModule.forRootAsync({
          useFactory: () => {
            // 1. If running on Render (Cloud)
            if (process.env.REDIS_URL) {
              const url = new URL(process.env.REDIS_URL);
              return {
                connection: {
                  host: url.hostname,
                  port: Number(url.port),
                  username: url.username,
                  password: url.password,
                  tls: {
                    rejectUnauthorized: false, // Essential for Upstash/Render
                  },
                },
                skipConfigValidation: true,
              };
            }
    
            //2. If running Locally
            return {
              connection: {
                host: process.env.REDIS_HOST || 'localhost',
                port: Number(process.env.REDIS_PORT || 6379),
                password: process.env.REDIS_PASSWORD,
              },
            };
          },
        }),
  ],
  controllers: [WorkerController],
  providers: [WorkerService],
})
export class WorkerModule {}
