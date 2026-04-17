import { Test, TestingModule } from '@nestjs/testing';
import { EnterpriseLeadsService } from './enterprise-leads.service';

describe('EnterpriseLeadsService', () => {
  let service: EnterpriseLeadsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EnterpriseLeadsService],
    }).compile();

    service = module.get<EnterpriseLeadsService>(EnterpriseLeadsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
