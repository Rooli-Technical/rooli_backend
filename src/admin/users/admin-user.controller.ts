import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { AdminUserService } from './admin.user.service';
import {
  AdminUserListResponseDto,
  ReactivateResponseDto,
  SuspendResponseDto,
  SuspendUserDto,
} from './admin.user.dto';
import { AdminRoute } from '@/common/decorators/admin-route.decorator';

@ApiTags('Admin-Users')
@ApiBearerAuth()
@AdminRoute()
@UseGuards(AdminJwtGuard)
@Controller('admin')
export class AdminUserController {
  constructor(private readonly adminUserService: AdminUserService) {}

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

  @Get('fetch-admins')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fetch all admins that can be assigned' })
  @ApiResponse({ status: 200, description: 'All admins' })
  getAllAdmins() {
    return this.adminUserService.getAdmins();
  }
}
