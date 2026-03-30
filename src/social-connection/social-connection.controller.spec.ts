import { Test, TestingModule } from '@nestjs/testing';
import { SocialConnectionController } from './social-connection.controller';
import { SocialConnectionService } from './social-connection.service';

describe('SocialConnectionController', () => {
  let controller: SocialConnectionController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SocialConnectionController],
      providers: [SocialConnectionService],
    }).compile();

    controller = module.get<SocialConnectionController>(
      SocialConnectionController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
