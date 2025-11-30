import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@/auth/decorators/current-user.decorator';

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
    console.log(req)
    return this.usersService.findById(req.user.id);
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
    return this.usersService.updateProfile(req.user.id, dto);
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
    return this.usersService.changePassword(req.user.id, dto);
  }

  @Delete('me')
  @ApiOperation({
    summary: 'Deactivate account',
    description: 'Soft deletes the authenticated user account.',
  })
  @ApiResponse({ status: 200, description: 'Account deactivated' })
  async deactivateAccount(@Req() req): Promise<void> {
    return this.usersService.deactivateMyAccount(req.user.id);
  }

  //there should be a guard to restrict organization access
  @Get('organization/:organizationId')
  @ApiOperation({
    summary: 'List users by organization',
    description:
      'Returns paginated list of users for a given organization with optional search and role filters.',
  })
  async getUsersByOrganization(
    @Param('organizationId') organizationId: string,
    @Query() filters: UserFiltersDto,
  ) {
    return this.usersService.getUsersByOrganization(organizationId, filters);
  }


  @Get('me/social-accounts')
  @ApiOperation({ summary: "Get current user's accessible social accounts" })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async getMySocialAccounts(@Req() req) {
    const userId = req.user?.id;
    return this.usersService.getUserSocialAccounts(userId);
  }
}
