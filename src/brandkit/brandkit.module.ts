import { Module } from '@nestjs/common';
import { BrandKitService } from './brandkit.service';
import { BrandkitController } from './brandkit.controller';

@Module({
  controllers: [BrandkitController],
  providers: [BrandKitService],
  exports: [BrandKitService],
})
export class BrandkitModule {}
