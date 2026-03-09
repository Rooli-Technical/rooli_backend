import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { WorkerModule } from './worker/worker.module';


@Module({
  imports: [
    // 1. CONFIGURATION (Copied from AppModule)
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    
    // 2. DATABASE (Essential for your processors)
    PrismaModule, 

    // 3. REDIS CONNECTION (Copied exactly from AppModule)
    BullModule.forRootAsync({
  inject: ['REDIS_OPTIONS'],
  useFactory: (redisOptions) => ({
    connection: redisOptions,
  }),
}),

    // 4. THE LOGIC (Your existing module)
    WorkerModule, 
  ],
})
export class WorkerAppModule {}