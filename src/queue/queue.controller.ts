import { Controller, UseGuards } from '@nestjs/common';
import { QueueService } from './queue.service';
import { FeatureGuard } from '@/common/guards/feature.guard';
import { RequireFeature } from '@/common/decorators/require-feature.decorator';

@Controller('queue')
@UseGuards(FeatureGuard)
@RequireFeature('queueScheduling')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}
}
