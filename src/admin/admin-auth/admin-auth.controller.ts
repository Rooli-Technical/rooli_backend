import { Controller, Post, Get, Body, Req, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiProperty,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminJwtGuard } from '../guards/admin-jwt.guard';
import { AdminRoute } from '@/common/decorators/admin-route.decorator';
import { AdminLoginDto, AdminLoginResponseDto } from './admin-auth.dto';

@AdminRoute()
@ApiTags('Admin — Auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  @ApiOperation({
    summary: 'Admin login',
    description:
      'Separate from the generic /auth/login. ' +
      'Only SUPER_ADMIN accounts can authenticate here. ' +
      'Token is signed with ADMIN_JWT_SECRET and expires in 8h.',
  })
  @ApiBody({ type: AdminLoginDto })
  @ApiResponse({
    status: 201,
    type: AdminLoginResponseDto,
    description: 'Login successful.',
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({
    status: 403,
    description: 'Not a SUPER_ADMIN account or account is locked.',
  })
  async login(@Req() req: Request, @Body() body: AdminLoginDto) {
    const ip =
      req.ip ||
      req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
      'unknown';
    console.log('IP Address', ip);
    return this.adminAuthService.login(body.email, body.password, ip);
  }

  @Post('logout')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout — invalidates current admin session' })
  @ApiResponse({ status: 201, description: 'Logged out successfully.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  async logout(@Req() req: Request) {
    const { userId } = req.user as any;
    return this.adminAuthService.logout(userId);
  }
}
