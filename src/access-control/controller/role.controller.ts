import {
  Controller,
  Post,
  Param,
  Body,
  Delete,
  HttpCode,
  HttpStatus,
  Get,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { UpdateRolePermissionsDto } from '../dtos/update-role-permission.dto';
import { RoleService } from '../services/roles.service';
import { FilterRolesDto } from '../dtos/filter-roles.dto';

@ApiTags('Roles - Permissions')
@ApiBearerAuth()
@Controller('roles')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Post(':roleId/permissions')
  @ApiOperation({ summary: 'Add permissions to a role' })
  @ApiParam({ name: 'roleId', type: String })
  @ApiBody({ type: UpdateRolePermissionsDto })
  @ApiResponse({ status: 201, description: 'Permissions added to role' })
  async addPermissionsToRole(
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRolePermissionsDto,
  ) {
    return this.roleService.addPermissionsToRole(roleId, dto.permissionIds);
  }

  @Delete(':roleId/permissions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove permissions from a role' })
  @ApiParam({ name: 'roleId', type: String })
  @ApiBody({ type: UpdateRolePermissionsDto })
  @ApiResponse({ status: 200, description: 'Permissions removed from role' })
  async removePermissionsFromRole(
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRolePermissionsDto,
  ) {
    return this.roleService.removePermissionsFromRole(
      roleId,
      dto.permissionIds,
    );
  }

  @Get('/filter/all')
  @ApiOperation({ summary: 'Get all roles with filters' })
  @ApiQuery({ name: 'scope', required: false })
  @ApiQuery({ name: 'organizationId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'includeSystem', required: false })
  @ApiResponse({
    status: 200,
    description: 'Filtered roles fetched successfully',
  })
  async getAllWithFilters(@Query() filters: FilterRolesDto) {
    return this.roleService.findAllWithFilters(filters);
  }

  @Get(':roleId/permissions')
  @ApiOperation({ summary: 'Get all permissions assigned to a role' })
  @ApiParam({ name: 'roleId', type: String })
  @ApiResponse({ status: 200, description: 'Role permissions fetched' })
  async getPermissionsForRole(@Param('roleId') roleId: string) {
    return this.roleService.getPermissionsForRole(roleId);
  }
}
