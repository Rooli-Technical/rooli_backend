import { Test, TestingModule } from '@nestjs/testing';
import { BrandkitService } from './brandkit.service';

describe('BrandkitService', () => {
  let service: BrandkitService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BrandkitService],
    }).compile();

    service = module.get<BrandkitService>(BrandkitService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
