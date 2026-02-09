import { Module } from '@nestjs/common';
import { PostMediaService } from './post-media.service';
import { PostMediaController } from './post-media.controller';
import { ConfigModule } from '@nestjs/config';
import { CloudinaryProvider } from './cloudinary.provider';

@Module({
  imports: [ConfigModule], 
  controllers: [PostMediaController],
  providers: [PostMediaService, CloudinaryProvider],
  exports: [PostMediaService],
})
export class PostMediaModule {}
