import { Test, TestingModule } from '@nestjs/testing';
import { BrandkitController } from './brandkit.controller';
import { BrandkitService } from './brandkit.service';

describe('BrandkitController', () => {
  let controller: BrandkitController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BrandkitController],
      providers: [BrandkitService],
    }).compile();

    controller = module.get<BrandkitController>(BrandkitController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
