import { Test, TestingModule } from '@nestjs/testing';
import { PlanAccessServiceController } from './plan-access.controller';
import { PlanAccessServiceService } from './plan-access.service';

describe('PlanAccessServiceController', () => {
  let controller: PlanAccessServiceController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlanAccessServiceController],
      providers: [PlanAccessServiceService],
    }).compile();

    controller = module.get<PlanAccessServiceController>(
      PlanAccessServiceController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
