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
import { UserService } from './user.service';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { UpdateProfileDto } from './dtos/update-profile.dto';
import { UserFiltersDto } from './dtos/user-filters.dto';
import { SafeUser } from '@/auth/dtos/AuthResponse.dto';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { CreateOrganizationDto } from '@/organizations/dtos/create-organization.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UserController {
  constructor(private readonly usersService: UserService) {}

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({
    summary: 'Get current user',
    description: 'Returns the currently authenticated user information.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current user retrieved',
    type: SafeUser,
  })
  async getCurrentUser(@Req() req): Promise<SafeUser> {

    return this.usersService.findById(req.user.userId);
  }

  @Patch('me/profile')
  @ApiOperation({
    summary: 'Update user profile',
    description:
      'Updates first name, last name, and avatar for the authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'Profile updated', type: SafeUser })
  async updateProfile(
    @Req() req,
    @Body() dto: UpdateProfileDto,
  ): Promise<SafeUser> {
    return this.usersService.updateProfile(req.user.userId, dto);
  }

  @Patch('me/password')
  @ApiOperation({
    summary: 'Change password',
    description:
      'Changes the password of the authenticated user after verifying current password.',
  })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  async changePassword(
    @Req() req,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.usersService.changePassword(req.user.userId, dto);
  }

  @Delete('me')
  @ApiOperation({
    summary: 'Deactivate account',
    description: 'Soft deletes the authenticated user account.',
  })
  @ApiResponse({ status: 200, description: 'Account deactivated' })
  async deactivateAccount(@Req() req): Promise<void> {
    return this.usersService.deactivateMyAccount(req.user.userId);
  }

@Get('user/workspaces')
  @ApiOperation({ 
    summary: 'Get current user workspaces', 
    description: 'Returns all workspaces the authenticated user belongs to across all organizations.' 
  })
  @ApiResponse({ status: 200, description: 'Workspaces retrieved successfully.' })
  async getMyWorkspaces(
    @CurrentUser('userId') userId: string, 
  ) {
    return this.usersService.getUserWorkspaces(userId);
  }
}

