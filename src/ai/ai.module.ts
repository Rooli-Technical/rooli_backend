import { Module } from '@nestjs/common';
import { AiService } from './service/ai.service';
import { AiController } from './ai.controller';

@Module({
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
