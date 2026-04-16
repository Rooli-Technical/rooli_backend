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
  ApiParam,
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
import { ListMembersQueryDto } from './dtos/list-members.dto';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { UpdateOrgMemberRoleDto } from './dtos/update-member-role.dto';
import { OrganizationMemberService } from './organization-member/organization-member.service';
import { PermissionAction, PermissionResource } from '@/common/constants/rbac';
import { BypassSubscription } from '@/common/decorators/bypass-subscription.decorator';
import { AllowSuspended } from '@/common/decorators/allow-suspended.decorator';

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('organizations')
@UseGuards(ContextGuard, PermissionsGuard)
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly organizationMembersService: OrganizationMemberService,
  ) {}

  @Post()
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
  async createOrganization(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.organizationsService.createOrganization(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all organizations with optional filters' })
  @ApiOkResponse({ description: 'List of organizations' })
  async getAll(
    @Query() query: GetAllOrganizationsDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.organizationsService.getAllOrganizations(userId, query);
  }

  @Get(':organizationId')
  @RequirePermission(PermissionResource.ORGANIZATION, PermissionAction.READ)
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
  async getOrganization(@Param('organizationId') orgId: string) {
    return this.organizationsService.getOrganization(orgId);
  }

  @Patch(':organizationId/members/:memberId/role')
  @RequirePermission(PermissionResource.ORG_MEMBERS, PermissionAction.UPDATE)
  @ApiOperation({ summary: 'Update member role (Promotion/Demotion)' })
  async updateRole(
    @Param('organizationId') organizationId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateOrgMemberRoleDto,
  ) {
    return this.organizationMembersService.updateRole({
      organizationId,
      memberId,
      roleId: dto.roleId,
    });
  }

  @Patch(':organizationId/activate')
  @BypassSubscription() // Only for this endpoint, as it's meant to help users get back in after a billing issue
  @AllowSuspended() // Allow suspended orgs to access this endpoint
  @RequirePermission(PermissionResource.ORGANIZATION, PermissionAction.UPDATE)
  @ApiOperation({ summary: 'Reactivate a previously deactivated organization' })
  @ApiResponse({
    status: 200,
    description: 'Organization reactivated successfully',
  })
  async activateOrganization(@Param('organizationId') orgId: string) {
    return this.organizationsService.activateOrganization(orgId);
  }

  @Patch(':organizationId')
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
    @Param('organizationId') orgId: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateOrganization(orgId, dto);
  }

  @Delete(':organizationId/members/:memberId')
  @RequirePermission(PermissionResource.ORG_MEMBERS, PermissionAction.DELETE)
  @ApiOperation({ summary: 'Remove a member from the entire organization' })
  async remove(
    @Param('organizationId') organizationId: string,
    @Param('memberId') memberId: string,
    @CurrentUser('userId') actorUserId: string,
  ) {
    return this.organizationMembersService.remove({
      actorId: actorUserId,
      organizationId,
      memberId,
    });
  }

  @Post(':organizationId/leave')
  @ApiOperation({ summary: 'Voluntarily leave the organization' })
  async leave(
    @Param('organizationId') organizationId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.organizationMembersService.leave(userId, organizationId);
  }

  @Get(':organizationId/summary')
  @RequirePermission(PermissionResource.ORG_BILLING, PermissionAction.READ)
  @ApiOperation({ summary: 'Get organization usage summary' })
  async getSummary(@Param('organizationId') organizationId: string) {
    return this.organizationsService.getOrganizationSummary(organizationId);
  }

  @Get(':organizationId/members')
  @RequirePermission(PermissionResource.ORG_MEMBERS, PermissionAction.READ)
  @ApiOperation({
    summary: 'List organization members',
    description:
      'Returns a paginated list of members belonging to a specific organization with search capabilities.',
  })
  @ApiParam({
    name: 'organizationId',
    description: 'The unique ID of the organization',
    example: 'cmnrgzxs30000shia1wff9zr3',
  })
  @ApiResponse({
    status: 200,
    description: 'List of members retrieved successfully.',
  })
  @ApiResponse({ status: 404, description: 'Organization not found.' })
  async listMembers(
    @Param('organizationId') organizationId: string,
    @Query() query: ListMembersQueryDto,
  ) {
    return this.organizationMembersService.listOrganizationMembers({
      organizationId,
      query,
    });
  }
  @Get(':organizationId/members/:memberId')
  @RequirePermission(PermissionResource.ORG_MEMBERS, PermissionAction.READ)
  @ApiOperation({ summary: 'Get organization member' })
  @ApiResponse({ status: 200, description: 'Member retrieved successfully.' })
  async getOrganizationMember(
    @Param('memberId') memberId: string,
    @Param('organizationId') organizationId: string,
  ) {
    return this.organizationMembersService.getOneOrganizationMember(
      memberId,
      organizationId,
    );
  }

  @Delete(':organizationId')
  @RequirePermission(PermissionResource.ORGANIZATION, PermissionAction.DELETE)
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
  async deleteOrganization(@Param('organizationId') orgId: string) {
    return this.organizationsService.deleteOrganization(orgId);
  }
}
