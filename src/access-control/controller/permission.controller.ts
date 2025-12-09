import { Permission } from "@generated/client";
import { PermissionScope, PermissionResource } from "@generated/enums";
import { Controller, Post, Body, Get, Param, Delete, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBody, ApiResponse, ApiParam, ApiBearerAuth } from "@nestjs/swagger";
import { CreatePermissionDto } from "../dtos/create-permission.dto";
import { PermissionService } from "../services/permissions.service";


@ApiTags('Permissions')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new permission' })
  @ApiBody({ type: CreatePermissionDto })
  @ApiResponse({ status: 201, description: 'Permission created' })
  @ApiResponse({ status: 409, description: 'Permission already exists' })
  create(@Body() dto: CreatePermissionDto): Promise<Permission> {
    return this.permissionService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all permissions' })
  @ApiResponse({ status: 200, description: 'List of permissions' })
  findAll(): Promise<Permission[]> {
    return this.permissionService.findAll();
  }


  @Get(':id')
  @ApiOperation({ summary: 'Get a permission by ID' })
  @ApiParam({ name: 'id', type: 'string' })
  @ApiResponse({ status: 200, description: 'Permission object' })
  @ApiResponse({ status: 404, description: 'Permission not found' })
  findById(@Param('id') id: string): Promise<Permission> {
    return this.permissionService.findById(id);
  }

  @Get('scope/:scope')
  @ApiOperation({ summary: 'Get permissions by scope' })
  @ApiParam({ name: 'scope', enum: PermissionScope })
  findByScope(@Param('scope') scope: PermissionScope): Promise<Permission[]> {
    return this.permissionService.findByScope(scope);
  }

  @Get('scope/:scope/resource/:resource')
  @ApiOperation({ summary: 'Get permissions by scope and resource' })
  @ApiParam({ name: 'scope', enum: PermissionScope })
  @ApiParam({ name: 'resource', enum: PermissionResource })
  findByResource(
    @Param('scope') scope: PermissionScope,
    @Param('resource') resource: PermissionResource,
  ): Promise<Permission[]> {
    return this.permissionService.findByResource(scope, resource);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a permission by ID' })
  @ApiParam({ name: 'id', type: 'string' })
  @ApiResponse({ status: 204, description: 'Permission deleted' })
  @ApiResponse({ status: 409, description: 'Cannot delete permission assigned to roles' })
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string) {
    return this.permissionService.delete(id);
  }
}
