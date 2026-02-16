import { Controller, Get } from '@nestjs/common';
import {  RoleService } from './rbac.service';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Roles & Permissions')
@ApiBearerAuth()
@Controller('rbac')
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
}
