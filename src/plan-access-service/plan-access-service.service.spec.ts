import { Test, TestingModule } from '@nestjs/testing';
import { PlanAccessServiceService } from './plan-access-service.service';

describe('PlanAccessServiceService', () => {
  let service: PlanAccessServiceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PlanAccessServiceService],
    }).compile();

    service = module.get<PlanAccessServiceService>(PlanAccessServiceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
