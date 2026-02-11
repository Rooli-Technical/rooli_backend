import { Module } from '@nestjs/common';
import { LabelController } from './labels.controller';
import { LabelService } from './labels.service';

@Module({
  controllers: [LabelController],
  providers: [LabelService],
})
export class LabelsModule {}
