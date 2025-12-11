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
import { OrganizationUsageDto } from './dtos/organization-usage.dto';
import { OrganizationStatsDto } from './dtos/organization-stats.dto';
import { GetAllOrganizationsDto } from './dtos/get-organiations.dto';

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

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
  async createOrganization(@Req() req, @Body() dto: CreateOrganizationDto) {
    return this.organizationsService.createOrganization(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all organizations with optional filters' })
  @ApiOkResponse({ description: 'List of organizations' })
  async getAll(@Query() query: GetAllOrganizationsDto) {
    return this.organizationsService.getAllOrganizations(query);
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
      req.user.id,
      dto,
    );
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
    return this.organizationsService.deleteOrganization(orgId, req.user.id);
  }

  @Get(':id/usage')
  @ApiOperation({
    summary: 'Get organization usage',
    description:
      'Returns statistics about organization usage like member count, AI credits, posts, and media storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization usage data retrieved',
    type: OrganizationUsageDto,
  })
  async getUsage(
    @Param('id') orgId: string,
  ): Promise<OrganizationUsageDto> {
    return this.organizationsService.getOrganizationUsage(orgId);
  }
}
