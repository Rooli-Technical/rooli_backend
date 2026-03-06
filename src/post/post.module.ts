import { Module, Post } from '@nestjs/common';
import { PostService } from './services/post.service';
import { PostController } from './controllers/post.controller';
import { PostApprovalController } from './controllers/post-approval.controller';
import { DestinationBuilder } from './services/destination-builder.service';
import { PostFactory } from './services/post-factory.service';
import { PlatformRulesService } from './services/platform-rules.service';
import { QueueModule } from '@/queue/queue.module';
import { WorkerModule } from '@/worker/worker.module';
import { SocialModule } from '@/social/social.module';
import { EncryptionService } from '@/common/utility/encryption.service';

@Module({
  imports: [
   WorkerModule,
    QueueModule,
    SocialModule
  ],
  controllers: [PostController, PostApprovalController],
  providers: [PostService, PostFactory, DestinationBuilder, PlatformRulesService,EncryptionService],
})
export class PostModule {}
