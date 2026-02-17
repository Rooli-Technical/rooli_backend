import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dtos/create-organization.dto';
import { UpdateOrganizationDto } from './dtos/update-organization.dto';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiOkResponse,
} from '@nestjs/swagger';
import { GetAllOrganizationsDto } from './dtos/get-organiations.dto';
import { ContextGuard } from '@/common/guards/context.guard';
import { PermissionsGuard } from '@/common/guards/permission.guard';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { PermissionResource, PermissionAction } from '@generated/enums';
import { ListMembersQueryDto } from './dtos/list-members.dto';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { UpdateOrgMemberRoleDto } from './dtos/update-member-role.dto';

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('organizations')
@UseGuards(ContextGuard, PermissionsGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
   @RequirePermission(PermissionResource.ORGANIZATION, PermissionAction.CREATE)
  @ApiOperation({
    summary: 'Create organization',
    description:
      'Creates a new organization and assigns the authenticated user as owner.',
  })
  @ApiResponse({
    status: 201,
    description: 'Organization created successfully',
    schema: {
      example: {
        id: 'org-uuid',
        name: 'Acme Corp',
        slug: 'acme-corp',
        timezone: 'UTC',
        billingEmail: 'billing@acme.com',
        planTier: 'FREE',
        planStatus: 'ACTIVE',
        maxMembers: 5,
        monthlyCreditLimit: 1000,
      },
    },
  })
  async createOrganization(@Req() req, @Body() dto: CreateOrganizationDto) {
    return this.organizationsService.createOrganization(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all organizations with optional filters' })
  @ApiOkResponse({ description: 'List of organizations' })
  async getAll(@Query() query: GetAllOrganizationsDto) {
    return this.organizationsService.getAllOrganizations(query);
  }

  @Get(':organizationId/members')
  @ApiOperation({ 
    summary: 'List organization members', 
    description: 'Returns a paginated list of all members within a specific organization.' 
  })
  @ApiResponse({ status: 200, description: 'Members retrieved successfully.' })
  @ApiResponse({ status: 404, description: 'Organization not found.' })
  async getMembers(
    @Param('organizationId') organizationId: string,
    @Query() query: ListMembersQueryDto,
  ) {
    return this.organizationsService.listOrganizationMembers({
      organizationId,
      query,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get organization',
    description:
      'Returns organization details if the authenticated user is a member.',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization details retrieved',
    schema: {
      example: {
        id: 'org-uuid',
        name: 'Acme Corp',
        slug: 'acme-corp',
        timezone: 'UTC',
        billingEmail: 'billing@acme.com',
        isActive: true,
      },
    },
  })
  async getOrganization(@Param('id') orgId: string) {
    return this.organizationsService.getOrganization(orgId);
  }

  @Patch(':id')
  @RequirePermission(PermissionResource.ORGANIZATION, PermissionAction.UPDATE)
  @ApiOperation({
    summary: 'Update organization',
    description:
      'Updates organization details. Only accessible by organization owners.',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization updated successfully',
    schema: {
      example: {
        id: 'org-uuid',
        name: 'Updated Name',
        slug: 'updated-slug',
        timezone: 'UTC',
        billingEmail: 'billing@acme.com',
        updatedAt: '2025-09-25T10:00:00.000Z',
      },
    },
  })
  async updateOrganization(
    @Req() req,
    @Param('id') orgId: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateOrganization(
      orgId,
      dto,
    );
  }

  @Patch(':memberId/role')
  @RequirePermission(PermissionResource.MEMBERS, PermissionAction.UPDATE)
  @ApiOperation({ summary: 'Update member role (Promotion/Demotion)' })
  async updateRole(
    @Param('organizationId') organizationId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateOrgMemberRoleDto,
  ) {
    return this.organizationsService.updateRole({
      organizationId,
      memberId,
      roleId: dto.roleId,
    });
  }

  @Delete(':memberId')
  @RequirePermission(PermissionResource.MEMBERS, PermissionAction.DELETE)
  @ApiOperation({ summary: 'Remove a member from the entire organization' })
  async remove(
    @Param('organizationId') organizationId: string,
    @Param('memberId') memberId: string,
    @CurrentUser('userId') actorUserId: string,
  ) {

    return this.organizationsService.remove({
      actorId: actorUserId, 
      organizationId,
      memberId,
    });
  }

  @Post('leave')
  @ApiOperation({ summary: 'Voluntarily leave the organization' })
  async leave(
    @Param('organizationId') organizationId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.organizationsService.leave(userId, organizationId);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Deactivate an organization',
    description:
      'Soft deletes an organization and deactivates all members. Only owners can perform this.',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization deleted successfully',
    schema: {
      example: { success: true, message: 'Organization deleted successfully' },
    },
  })
  async deleteOrganization(@Req() req, @Param('id') orgId: string) {
    return this.organizationsService.deleteOrganization(orgId, req.user.userId);
  }
}
