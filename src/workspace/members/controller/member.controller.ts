import { 
  Controller, 
  Get, 
  Post, 
  Patch, 
  Delete, 
  Body, 
  Param, 
  Query, 
  UseGuards, 

} from '@nestjs/common';
import { 
  ApiTags, 
  ApiOperation, 
  ApiResponse, 
  ApiBearerAuth, 
  ApiParam 
} from '@nestjs/swagger';
import { AddWorkspaceMemberDto } from '../dtos/add-workspace-member.dto';
import { ListMembersQueryDto } from '../dtos/list-members.dto';
import { UpdateWorkspaceMemberRoleDto } from '../dtos/update-member-role.dto';
import { WorkspaceMemberService } from '../member.service';
import { ContextGuard } from '@/common/guards/context.guard';
import { PermissionsGuard } from '@/common/guards/permission.guard';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { PermissionResource, PermissionAction } from '@generated/enums';


@ApiTags('Workspace Members')
@ApiBearerAuth()
@UseGuards(ContextGuard, PermissionsGuard)
@Controller('workspaces/:workspaceId/members')
export class WorkspaceMemberController {
  constructor(private readonly memberService: WorkspaceMemberService) {}

  @Post()
  @RequirePermission(PermissionResource.MEMBERS, PermissionAction.CREATE)
  @ApiOperation({ 
    summary: 'Add a member to workspace', 
    description: 'Adds an existing Organization Member to this specific Workspace.' 
  })
  @ApiResponse({ status: 201, description: 'Member added successfully.' })
  @ApiResponse({ status: 400, description: 'User already in workspace or invalid role.' })
  @ApiParam({ name: 'workspaceId', description: 'Target Workspace ID' })
  async addMember(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: AddWorkspaceMemberDto,
  ) {
    return this.memberService.addMember({
      workspaceId,
      dto,
    });
  }

  @Get()
  @RequirePermission(PermissionResource.MEMBERS, PermissionAction.READ)
  @ApiOperation({ summary: 'List workspace members' })
  @ApiResponse({ status: 200, description: 'Paginated list of members.' })
  async listMembers(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListMembersQueryDto,
  ) {
    return this.memberService.listMembers({
      workspaceId,
      query,
    });
  }

  @Patch(':memberId')
  @RequirePermission(PermissionResource.MEMBERS, PermissionAction.UPDATE)
  @ApiOperation({ 
    summary: 'Update member role', 
    description: 'Change a member\'s role within the workspace. Send null to revert to Org-level role.' 
  })
  @ApiParam({ name: 'memberId', description: 'The Workspace Member ID (not User ID)' })
  async updateRole(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateWorkspaceMemberRoleDto,
  ) {
    return this.memberService.updateMemberRole({
      workspaceId,
      workspaceMemberId: memberId,
      dto,
    });
  }

  @Delete(':memberId')
@RequirePermission(PermissionResource.MEMBERS, PermissionAction.DELETE)
  @ApiOperation({ 
    summary: 'Remove member', 
    description: 'Removes a user from the workspace. Prevents removing the last owner.' 
  })
  @ApiResponse({ status: 204, description: 'Member removed.' })
  @ApiResponse({ status: 400, description: 'Cannot remove the last owner.' })
  async removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
  ) {
    await this.memberService.removeMember({
      workspaceId,
      workspaceMemberId: memberId,
    });
  }
}