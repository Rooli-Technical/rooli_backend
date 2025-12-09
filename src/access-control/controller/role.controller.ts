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
  Patch,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { UpdateRolePermissionsDto } from '../dtos/update-role-permission.dto';
import { RoleService } from '../services/roles.service';
import { FilterRolesDto } from '../dtos/filter-roles.dto';
import { CreateRoleDto } from '../dtos/create-role.dto';
import { UpdateRoleDto } from '../dtos/update-role.dto';

@ApiTags('Roles - Permissions')
@ApiBearerAuth()
@Controller('roles')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

   @Get('/organization/:orgId')
  @ApiOperation({ summary: 'Get all roles for an organization (including system roles)' })
  @ApiParam({ name: 'orgId', description: 'Organization ID' })
  @ApiOkResponse({ description: 'List of organization roles' })
  async getRolesForOrganization(@Param('orgId') orgId: string) {
    return this.roleService.getRolesForOrganization(orgId);
  }


  @Get('/:roleId')
  @ApiOperation({ summary: 'Get role by ID (optionally scoped to organization)' })
  @ApiParam({ name: 'roleId', description: 'Role ID' })
  @ApiQuery({
    name: 'organizationId',
    required: false,
    description: 'Optional organization scope check',
  })
  @ApiOkResponse({ description: 'Role fetched successfully' })
  async getRoleById(
    @Param('roleId') roleId: string,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.roleService.getRoleById(roleId, organizationId);
  }


  @Post()
  @ApiOperation({ summary: 'Create a new role' })
  @ApiOkResponse({ description: 'Role created successfully' })
  async create(@Body() dto: CreateRoleDto) {
    return this.roleService.create(dto);
  }


  @Patch('/:roleId')
  @ApiOperation({ summary: 'Update role details or permissions' })
  @ApiParam({ name: 'roleId', description: 'Role ID' })
  @ApiOkResponse({ description: 'Role updated successfully' })
  async update(
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.roleService.update(roleId, dto);
  }

  @Delete('/:roleId')
  @ApiOperation({ summary: 'Delete a role' })
  @ApiParam({ name: 'roleId', description: 'Role ID' })
  @ApiOkResponse({ description: 'Role deleted successfully' })
  async delete(@Param('roleId') roleId: string) {
    return this.roleService.delete(roleId);
  }

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
