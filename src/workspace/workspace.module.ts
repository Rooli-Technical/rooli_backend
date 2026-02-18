import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { WorkspaceController } from './workspace.controller';
import { AuthModule } from '@/auth/auth.module';
import { WorkspaceMemberService } from './members/member.service';
import { WorkspaceMemberController } from './members/controller/member.controller';

@Module({
  imports: [AuthModule],
  controllers: [WorkspaceController, WorkspaceMemberController],
  providers: [WorkspaceService, WorkspaceMemberService],
})
export class WorkspaceModule {}
