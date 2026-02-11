import { Module } from '@nestjs/common';
import { QueueSlotController } from './queue.controller';
import { QueueSlotService } from './queue.service';
import { WorkerModule } from '@/worker/worker.module';


@Module({
   imports: [
     WorkerModule,
    ],
  controllers: [QueueSlotController],
  providers: [QueueSlotService],
  exports: [QueueSlotService],
})
export class QueueModule {}
