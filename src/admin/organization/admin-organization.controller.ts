import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiProperty,
  ApiParam,
} from '@nestjs/swagger';
import { AdminJwtGuard } from '../guards/admin-jwt.guard';
import { AdminOrganizationService } from './admin-organization.service';
import {
  ActiveOrgResponseDto,
  AdminOrgListResponseDto,
  DeleteOrgResponseDto,
  SuspendOrgResponseDto,
} from './admin-organization.dto';

@ApiTags('Admin-Organization')
@ApiBearerAuth()
@UseGuards(AdminJwtGuard)
@Controller('admin')
export class AdminOrganizationController {
  constructor(private readonly organizationService: AdminOrganizationService) {}

  @Get('organization')
  @ApiOperation({
    summary: 'List all organizations',
    description:
      'Returns a paginated list of organizations with their plan, member count, ' +
      'workspace count, social connections count, and owner details. ' +
      'Supports search by name, slug, or email, and filter by status.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    example: 'tech solutions',
    description: 'Search by name, slug, or email',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    enum: ['ACTIVE', 'SUSPENDED', 'PENDING_PAYMENT'],
    description: 'Filter by organization status',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    type: String,
    example: '2025-01-01T00:00:00.000Z',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    type: String,
    example: '2025-12-31T23:59:59.999Z',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    description: 'Page number. Defaults to 1.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 20,
    description: 'Items per page. Defaults to 20. Max 100.',
  })
  @ApiResponse({
    status: 200,
    type: AdminOrgListResponseDto,
    description: 'Organizations retrieved successfully.',
  })
  @ApiResponse({ status: 400, description: 'Invalid status filter.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden. Admin only.' })
  async listOrganizations(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.organizationService.listOrganizations({
      search,
      status,
      dateFrom,
      dateTo,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Get('organization/metrics')
  @ApiResponse({
    status: 200,
    description: 'Organization metrics fetched successfully.',
  })
  async getOrganizationMetrics() {
    const metrics = await this.organizationService.getOrganizationMetrics();
    return metrics;
  }
  // ── GET /admin/organizations/:id ───────────────────────────────────────────

  @Get('organization/:id')
  @ApiOperation({
    summary: 'View organization details',
    description:
      'Returns full details of a single organization including subscription, ' +
      'plan limits, member list, and usage counts.',
  })
  @ApiParam({ name: 'id', example: 'clxorg123' })
  @ApiResponse({
    status: 200,
    description: 'Organization details returned successfully.',
  })
  @ApiResponse({ status: 404, description: 'Organization not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden. Admin only.' })
  async getOrganizationDetails(@Param('id') id: string) {
    return this.organizationService.getOrganizationDetails(id);
  }

  // ── PATCH /admin/organizations/:id/suspend ─────────────────────────────────

  @Patch('organization/:id/suspend')
  @ApiOperation({
    summary: 'Suspend an organization',
    description:
      'Sets the organization status to SUSPENDED and marks it as inactive. ' +
      'This prevents all members from accessing the platform.',
  })
  @ApiParam({ name: 'id', example: 'clxorg123' })
  @ApiResponse({
    status: 200,
    type: SuspendOrgResponseDto,
    description: 'Organization suspended successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Organization is already suspended.',
  })
  @ApiResponse({ status: 404, description: 'Organization not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden. Admin only.' })
  async suspendOrganization(@Param('id') id: string) {
    return this.organizationService.suspendOrganization(id);
  }

  @Patch('organization/:id/activate')
  @ApiOperation({
    summary: 'Activate an organization',
    description:
      'Sets the organization status to ACTIVE and marks it as inactive. ' +
      'This prevents all members from accessing the platform.',
  })
  @ApiParam({ name: 'id', example: 'clxorg123' })
  @ApiResponse({
    status: 200,
    type: ActiveOrgResponseDto,
    description: 'Organization activated successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Organization is already activated.',
  })
  @ApiResponse({ status: 404, description: 'Organization not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden. Admin only.' })
  async activateOrganization(@Param('id') id: string) {
    return this.organizationService.activateOrganization(id);
  }
  // ── DELETE /admin/organizations/:id ───────────────────────────────────────

  @Delete('organization/:id')
  @ApiOperation({
    summary: 'Delete an organization',
    description:
      'Permanently deletes the organization and all associated data ' +
      '(workspaces, posts, members etc.) via Prisma cascade rules. This action is irreversible.',
  })
  @ApiParam({ name: 'id', example: 'clxorg123' })
  @ApiResponse({
    status: 200,
    type: DeleteOrgResponseDto,
    description: 'Organization deleted successfully.',
  })
  @ApiResponse({ status: 404, description: 'Organization not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden. Admin only.' })
  async deleteOrganization(@Param('id') id: string) {
    return this.organizationService.deleteOrganization(id);
  }
}
