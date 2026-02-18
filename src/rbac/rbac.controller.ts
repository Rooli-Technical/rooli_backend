import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {  RoleService } from './rbac.service';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { CreateRoleDto } from './dtos/create-role.dto';
import { ListPermissionsQuery } from './dtos/list-permissions-query.dto';
import { ListRolesQuery } from './dtos/list-roles-query.dto';
import { ReplaceRolePermissionsDto } from './dtos/replace-role-permissions.dto';
import { UpdateRoleDto } from './dtos/update-role.dto';

@ApiTags('Roles & Permissions')
@ApiBearerAuth()
@Controller('organizations/:orgId/roles')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  @ApiOperation({ 
    summary: 'Get all roles with their assigned permissions',
    description: 'Returns a list of roles categorized by scope (System, Organization, Workspace).' 
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Returns list of roles.',
    schema: {
      example: [
        {
          id: 'cl123456789',
          name: 'Editor',
          slug: 'editor',
          scope: 'WORKSPACE',
          permissions: [
            { resource: 'POSTS', action: 'CREATE' },
            { resource: 'POSTS', action: 'PUBLISH' }
          ]
        }
      ]
    }
  })
  async getAllRoles() {
    return await this.roleService.getAllRolesWithPermissions();
  }


  @Get('permissions')
  @ApiOperation({ summary: 'List all available system permissions' })
  async listPermissions(@Query() query: ListPermissionsQuery) {
    return this.roleService.listPermissions(query);
  }

  @Get('catalog')
  @ApiOperation({ summary: 'Get permission metadata (Enums) for UI builders' })
  getPermissionCatalog() {
    return this.roleService.getPermissionCatalog();
  }

  @Get()
  @ApiOperation({ summary: 'List all roles available in the organization' })
  async listRoles(
    @Param('orgId') orgId: string,
    @CurrentUser('userId') userId: string,
    @Query() query: ListRolesQuery,
  ) {
    return this.roleService.listOrganizationRoles({ userId, organizationId: orgId, query });
  }

  @Post()
  @ApiOperation({ summary: 'Create a custom organization role' })
  @ApiResponse({ status: 201, description: 'Role created successfully' })
  async createRole(
    @Param('orgId') orgId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateRoleDto,
  ) {
    return this.roleService.createRole({ userId, organizationId: orgId, dto });
  }

  @Get(':roleId')
  @ApiOperation({ summary: 'Get detailed role info with permissions' })
  @ApiParam({ name: 'roleId', type: 'string' })
  async getRole(
    @Param('orgId') orgId: string,
    @Param('roleId') roleId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.roleService.getRole({ userId, organizationId: orgId, roleId });
  }

  @Patch(':roleId')
  @ApiOperation({ summary: 'Update role metadata (Name/Description)' })
  async updateRole(
    @Param('orgId') orgId: string,
    @Param('roleId') roleId: string,
   @CurrentUser('userId') userId: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.roleService.updateRole({ userId, organizationId: orgId, roleId, dto });
  }

  @Put(':roleId/permissions')
  @ApiOperation({ summary: 'Sync/Replace all permissions for a specific role' })
  async replacePermissions(
    @Param('orgId') orgId: string,
    @Param('roleId') roleId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: ReplaceRolePermissionsDto,
  ) {
    return this.roleService.replaceRolePermissions({ userId, organizationId: orgId, roleId, dto });
  }

  @Delete(':roleId')
  @ApiOperation({ summary: 'Delete a custom role' })
  async deleteRole(
    @Param('orgId') orgId: string,
    @Param('roleId') roleId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.roleService.deleteRole({ userId, organizationId: orgId, roleId });
  }

  @Get(':roleId/usage')
  @ApiOperation({ summary: 'Check how many members are using this role before deletion' })
  async getUsage(
    @Param('orgId') orgId: string,
    @Param('roleId') roleId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.roleService.getRoleUsage({ userId, organizationId: orgId, roleId });
  }

}
