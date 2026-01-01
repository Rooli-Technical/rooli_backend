import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthResponse } from './dtos/AuthResponse.dto';
import { ForgotPassword } from './dtos/ForgotPassword.dto';
import { Login } from './dtos/Login.dto';
import { Register } from './dtos/Register.dto';
import { ResetPassword } from './dtos/ResetPassword.dto';
import { Public } from '../common/decorators/public.decorator';
import { User } from '@generated/client';
import { AuthGuard } from '@nestjs/passport';
import { OnboardingDto } from './dtos/user-onboarding.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 } })
  @ApiOperation({
    summary: 'Register a new user',
    description:
      'Registers a user with email/password and sends verification email',
  })
  @ApiBody({ type: Register, description: 'User registration data' })
  async register(@Body() registerDto: Register, @Ip() ip: string): Promise<AuthResponse> {
    return this.authService.register(registerDto, ip);
  }

  @Post('login')
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60 } })
  @ApiOperation({
    summary: 'User login',
    description: 'Login with email and password to receive JWT tokens',
  })
  @ApiBody({ type: Login, description: 'User login credentials' })
  async login(@Body() loginDto: Login) {
    return this.authService.login(loginDto);
  }

  @Post('refresh')
  @Public()
  @ApiOperation({
    summary: 'Refresh JWT tokens',
    description: 'Provide refresh token to get new access and refresh tokens',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        refreshToken: { type: 'string', example: 'eyJhbGciOi...' },
      },
    },
  })
  async refresh(
    @Body('refreshToken') refreshToken: string,
  ): Promise<AuthResponse> {
    return this.authService.refreshTokens(refreshToken);
  }

  @Post('verify-email')
  @Public()
  @ApiOperation({
    summary: 'Verify user email',
    description: 'Verify a newly registered user using token sent via email',
  })
  @ApiQuery({ name: 'token', example: 'random_verification_token' })
  async verifyEmail(
    @Query('token') token: string,
  ): Promise<{ message: string }> {
    await this.authService.verifyEmail(token);
    return { message: 'Email verified successfully' };
  }

  @Post('forgot-password')
  @Public()
  @ApiOperation({
    summary: 'Request password reset',
    description: 'Send password reset email with token',
  })
  @ApiBody({
    type: ForgotPassword,
    description: 'User email for password reset',
  })
  async forgotPassword(
    @Body() dto: ForgotPassword,
  ): Promise<{ message: string }> {
    await this.authService.forgotPassword(dto);
    return { message: 'Password reset email sent if user exists' };
  }

  @Post('reset-password')
  @Public()
  @ApiOperation({
    summary: 'Reset password',
    description: 'Reset user password using token from email',
  })
  @ApiBody({ type: ResetPassword, description: 'Reset token and new password' })
  async resetPassword(
    @Body() dto: ResetPassword,
  ): Promise<{ message: string }> {
    await this.authService.resetPassword(dto);
    return { message: 'Password reset successful' };
  }

  @Post('resend-verification')
  @Public()
  @ApiOperation({
    summary: 'Resend email verification',
    description:
      'Resend verification email if user has not verified their email',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { email: { type: 'string', example: 'user@example.com' } },
    },
  })
  async resendVerification(
    @Body('email') email: string,
  ): Promise<{ message: string }> {
    await this.authService.resendVerificationEmail(email);
    return {
      message: 'Verification email sent if user exists and is not verified',
    };
  }

  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Returns user profile',
    schema: {
      example: {
        id: 'a3f6c2e7-5b0a-42d9-9c9c-7c6a8b9f1234',
        email: 'user@example.com',
        firstName: 'John',
        lastName: 'Doe',
        role: 'USER',
        isEmailVerified: true,
      },
    },
  })
  async getProfile(@CurrentUser() user: User) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.systemRoleId,
      isEmailVerified: user.isEmailVerified,
    };
  }

  @Get('google')
  @Public()
  @UseGuards(AuthGuard('google'))
  @ApiOperation({
    summary: 'Initiate Google OAuth Login',
    description:
      'Redirects the user to Google for authentication. No response body is returned; Google handles the redirect.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirects to Google OAuth consent screen.',
  })
  googleAuth(@Req() req) {
    // Guard handles redirect
  }

  @Get('google/callback')
  @Public()
  @UseGuards(AuthGuard('google'))
  @ApiOperation({
    summary: 'Google OAuth Callback',
    description:
      'Google redirects here after login. The returned user data is processed, and tokens are generated.',
  })
  @ApiOkResponse({
    description: 'Successfully authenticated using Google',
  })
  async googleAuthRedirect(@Req() req, @Ip() ip: string) {
    const result = await this.authService.handleSocialLogin(req.user, ip);
    // Return JSON or redirect to frontend
    return result;
  }

  @Post('onboarding')
  @ApiOperation({
    summary: 'User Onboarding',
    description:
      'Onboarding for the new user',
  })
  @ApiResponse({
    status: 201,
    description: 'User onboarded successfully',
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
  async userOnboarding(@Req() req, @Body() dto: OnboardingDto) {
    return this.authService.userOnboarding(req.user.id, dto);
  }

  @Post('logout')
  @ApiOperation({ summary: 'Logout the current user' })
  @ApiResponse({ status: 200, description: 'Logged out successfully.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  async logout(@Req() req: any) {
    await this.authService.logout(req.user.id);
    return { message: 'Logged out successfully' };
  }
}
