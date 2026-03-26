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
import { AdminDashboardService } from './dashboard/admin-dashboard.service';
import { DashboardAnalyticsDto } from './dashboard/admin-dashboard.dto';
import {
  AdminUserListResponseDto,
  ReactivateResponseDto,
  SuspendResponseDto,
  SuspendUserDto,
} from './users/admin.user.dto';
import { AdminUserService } from './users/admin.user.service';
import { AdminOrganizationService } from './organization/admin-organization.service';
import { AdminJwtGuard } from './guards/admin-jwt.guard';

@ApiTags('Admin-Dashboard')
@ApiBearerAuth()
@UseGuards(AdminJwtGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly dashboardService: AdminDashboardService,
    private readonly adminUserService: AdminUserService,
  ) {}

  @Get('analytics')
  @ApiOperation({
    summary: 'Get all dashboard analytics',
    description:
      'Returns all admin dashboard data for the selected date range. ' +
      'Both dateFrom and dateTo are optional — omitting them defaults to the current month (start of month → now). ' +
      'Percentage change on each stat card is calculated against the equivalent previous period of the same duration. ' +
      'Infrastructure Health, User Distribution, and Connected Accounts always reflect the current live state regardless of date range.',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    type: String,
    example: '2025-01-01T00:00:00.000Z',
    description:
      'Start of the date range (ISO 8601). Defaults to start of current month.',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    type: String,
    example: '2025-06-30T23:59:59.999Z',
    description: 'End of the date range (ISO 8601). Defaults to now.',
  })
  @ApiResponse({
    status: 200,
    type: DashboardAnalyticsDto,
    description: 'Analytics returned successfully.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad Request — invalid date format or dateFrom is after dateTo.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden. Admin only.' })
  async getAnalytics(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.dashboardService.getDashboardData(dateFrom, dateTo);
  }

  @Get('users')
  @ApiOperation({
    summary: 'List all users with pagination',
    description:
      'Returns a paginated list of users with their workspace count. ' +
      'Filter by status tab (All / Active / Suspended / Banned), ' +
      'search by name or email, and filter by creation date range.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ALL', 'ACTIVE', 'SUSPENDED', 'BANNED'],
    example: 'ALL',
  })
  @ApiQuery({ name: 'search', required: false, type: String, example: 'chidi' })
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
  @ApiResponse({ status: 200, type: AdminUserListResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid status filter.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden. Admin only.' })
  async listUsers(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminUserService.listUsers({
      status,
      search,
      dateFrom,
      dateTo,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Patch('user/:id/suspend')
  @ApiOperation({
    summary: 'Suspend a user',
    description:
      'Locks the user account. Omit suspendUntil for indefinite suspension (year 2099). ' +
      'All active sessions are immediately invalidated.',
  })
  @ApiParam({ name: 'id', example: 'clx1234abc' })
  @ApiResponse({ status: 200, type: SuspendResponseDto })
  @ApiResponse({
    status: 400,
    description: 'User is banned or suspendUntil is in the past.',
  })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden. Admin only.' })
  async suspendUser(@Param('id') id: string, @Body() body: SuspendUserDto) {
    return this.adminUserService.suspendUser(id, body.suspendUntil);
  }

  @Patch('user/:id/reactivate')
  @ApiOperation({
    summary: 'Reactivate a user',
    description: 'Clears suspension or ban. Also resets login attempt counter.',
  })
  @ApiParam({ name: 'id', example: 'clx1234abc' })
  @ApiResponse({ status: 200, type: ReactivateResponseDto })
  @ApiResponse({ status: 400, description: 'User is already active.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden. Admin only.' })
  async reactivateUser(@Param('id') id: string) {
    return this.adminUserService.reactivateUser(id);
  }
}
