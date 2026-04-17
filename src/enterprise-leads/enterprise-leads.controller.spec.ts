import { Test, TestingModule } from '@nestjs/testing';
import { EnterpriseLeadsController } from './enterprise-leads.controller';
import { EnterpriseLeadsService } from './enterprise-leads.service';

describe('EnterpriseLeadsController', () => {
  let controller: EnterpriseLeadsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnterpriseLeadsController],
      providers: [EnterpriseLeadsService],
    }).compile();

    controller = module.get<EnterpriseLeadsController>(EnterpriseLeadsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
