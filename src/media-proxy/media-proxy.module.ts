import { Module } from '@nestjs/common';
import { MediaProxyController } from './media-proxy.controller';

@Module({
  controllers: [MediaProxyController],
})
export class MediaProxyModule {}
