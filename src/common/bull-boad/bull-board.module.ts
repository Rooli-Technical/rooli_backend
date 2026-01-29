import { Module } from '@nestjs/common';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { WorkerModule } from '@/worker/worker.module';
import { ExpressAdapter } from '@bull-board/express';

@Module({
  imports: [

    WorkerModule,

    BullBoardModule.forRoot({
     route: '/admin/queues', 
      adapter: ExpressAdapter,
      // optional basic auth:
      // username: process.env.BULLBOARD_USER,
      // password: process.env.BULLBOARD_PASS,
    }),

    BullBoardModule.forFeature({
      name: 'media-ingest',
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: 'publishing-queue',
      adapter: BullMQAdapter,
    }),
  BullBoardModule.forFeature({
      name: 'analytics-queue',
      adapter: BullMQAdapter,
    })
  ],
})
export class RooliBullBoardModule {}
