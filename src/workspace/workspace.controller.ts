import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { CreateWorkspaceDto } from './dtos/create-workspace.dto';
import { UpdateWorkspaceDto } from './dtos/update-workspace.dto';
import { ListWorkspacesQueryDto } from './dtos/list-workspaces.dto';
import { ContextGuard } from '@/common/guards/context.guard';
import { PermissionsGuard } from '@/common/guards/permission.guard';
import { PermissionResource, PermissionAction } from '@/common/constants/rbac';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';

@ApiTags('Workspace')
@ApiBearerAuth()
@UseGuards(ContextGuard, PermissionsGuard)
@Controller('organizations/:orgId/workspaces')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post()
  @RequirePermission(PermissionResource.ORGANIZATION, PermissionAction.MANAGE)
  @ApiOperation({ summary: 'Create a new workspace' })
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiResponse({ status: 201, description: 'Workspace created successfully' })
  @ApiResponse({ status: 403, description: 'Workspace limit reached' })
  async create(
    @CurrentUser() user: { userId: string },
    @Param('orgId') orgId: string,
    @Body() dto: CreateWorkspaceDto,
  ) {
    return this.workspaceService.createWorkspace(user.userId, orgId, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Get all workspaces (Admins see all, members see assigned only)',
  })
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  async findAll(
    @CurrentUser() user: { userId: string },
    @Param('orgId') orgId: string,
    @Query() query: ListWorkspacesQueryDto,
  ) {
    return this.workspaceService.listOrganizationWorkspaces(
      user.userId,
      orgId,
      query,
    );
  }

  @Get(':workspaceId')
  @RequirePermission(PermissionResource.WORKSPACE, PermissionAction.READ)
  @ApiOperation({ summary: 'Get workspace by ID' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async findOne(
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.workspaceService.getWorkspace(orgId, workspaceId);
  }

  @Patch(':workspaceId')
  @RequirePermission(
    PermissionResource.WORKSPACE_SETTINGS,
    PermissionAction.UPDATE,
  )
  @ApiOperation({ summary: 'Update workspace details' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  async update(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
    @Param('orgId') orgId: string,
  ) {
    return this.workspaceService.updateWorkspace(workspaceId, dto, orgId);
  }

  @Delete(':workspaceId')
  @RequirePermission(PermissionResource.WORKSPACE, PermissionAction.MANAGE)
  @ApiOperation({ summary: 'Delete a workspace' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  async delete(
    @Param('workspaceId') workspaceId: string,
    @Param('orgId') orgId: string,
  ) {
    return this.workspaceService.deleteWorkspace(workspaceId, orgId);
  }

  @Post(':workspaceId/switch')
  @ApiOperation({
    summary: 'Switch active workspace for current user',
  })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  async switchWorkspace(
    @CurrentUser() user: { userId: string },
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.workspaceService.switchWorkspace(user.userId, workspaceId);
  }
}
