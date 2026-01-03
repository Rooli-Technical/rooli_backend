import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { AddWorkspaceMemberDto } from './dtos/add-member.dto';
import { CreateWorkspaceDto } from './dtos/create-workspace.dto';
import { UpdateWorkspaceDto } from './dtos/update-workspace.dto';

@ApiTags('Workspace')
@ApiBearerAuth()
@Controller('organizations/:orgId/workspaces')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}


  @Post('orgId')
  @ApiOperation({ summary: 'Create a new workspace' })
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiResponse({ status: 201, description: 'Workspace created successfully' })
  @ApiResponse({ status: 403, description: 'Workspace limit reached' })
  async create(
    @CurrentUser() user: { id: string },
    @Param('orgId') orgId: string,
    @Body() dto: CreateWorkspaceDto,
  ) {
    return this.workspaceService.create(user.id, orgId, dto);
  }


  @Get('orgId')
  @ApiOperation({
    summary:
      'Get all workspaces (Admins see all, members see assigned only)',
  })
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  async findAll(
    @CurrentUser() user: { userId: string },
    @Param('orgId') orgId: string,
  ) {
    return this.workspaceService.findAll(orgId, user.userId);
  }


  @Get(':id')
  @ApiOperation({ summary: 'Get workspace by ID' })
  @ApiParam({ name: 'id', description: 'Workspace ID' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async findOne(@Param('orgId') orgId: string,@Param('id') id: string) {
    return this.workspaceService.findOne(orgId, id);
  }


  @Patch(':id')
  @ApiOperation({ summary: 'Update workspace details' })
  @ApiParam({ name: 'id', description: 'Workspace ID' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspaceService.update(id, dto);
  }


  @Delete(':id')
  @ApiOperation({ summary: 'Delete a workspace' })
  @ApiParam({ name: 'id', description: 'Workspace ID' })
  async delete(@Param('id') id: string) {
    return this.workspaceService.delete(id);
  }


  @Post(':id/switch')
  @ApiOperation({
    summary: 'Switch active workspace for current user',
  })
  @ApiParam({ name: 'id', description: 'Workspace ID' })
  async switchWorkspace(
    @CurrentUser() user: { id: string },
    @Param('id') workspaceId: string,
  ) {
    return this.workspaceService.switchWorkspace(user.id, workspaceId);
  }


  @Post(':id/members')
  @ApiOperation({ summary: 'Add member to workspace' })
  @ApiParam({ name: 'id', description: 'Workspace ID' })
  @ApiResponse({ status: 409, description: 'User already a member' })
  async addMember(
    @Param('id') workspaceId: string,
    @Body() dto: AddWorkspaceMemberDto,
  ) {
    return this.workspaceService.addMember(workspaceId, dto);
  }

  @Delete(':id/members/:userId')
  @ApiOperation({ summary: 'Remove member from workspace' })
  @ApiParam({ name: 'id', description: 'Workspace ID' })
  @ApiParam({ name: 'userId', description: 'User ID to remove' })
  async removeMember(
    @Param('id') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    return this.workspaceService.removeMember(workspaceId, userId);
  }
}