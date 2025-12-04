import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { LinkedInService } from './linkedIn.service';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConnectPagesBodyDto } from './dto/connect-pages.dto';
import { RefreshTokenRequestDto } from './dto/refresh-token.dto';
import { CallbackResponseDto } from './dto/callback-response.dto';
import { ConnectPagesResultDto } from './dto/connect-page-response.dto';
import { LinkedInCompanyPageDto } from './dto/discover-pages-response.dto';
import { ConnectedPageDto } from './dto/get-connected-pages.dto';

@ApiTags('LinkedIn - Auth')
@Controller('social/linkedin/auth')
@ApiBearerAuth()
export class LinkedinController {
  constructor(private readonly service: LinkedInService) {}

  @Get('connect/profile')
  @ApiOperation({
    summary: 'Begin OAuth to connect a personal LinkedIn profile.',
    description:
      'Generates the LinkedIn OAuth authorization URL for the authenticated user. ' +
      'The `userId` is extracted from the authenticated session/token and does not need to be sent by the client.',
  })
  @ApiResponse({
    status: 200,
    description: 'Authorization URL generated successfully.',
    schema: {
      example:
        'https://www.linkedin.com/oauth/v2/authorization?response_type=code...',
    },
  })
  async connectProfile(@Req() req) {
    return this.service.getProfileAuthUrl(req.user.id);
  }

  @Get('connect/pages')
  @ApiOperation({
    summary: 'Begin OAuth to discover and connect LinkedIn Company Pages',
    description:
      'Starts the LinkedIn OAuth process for page discovery. The authenticated user is automatically used; frontend send an internal `organizationId` to link discovered pages.',
  })
  @ApiQuery({
    name: 'organizationId',
    required: true,
    type: String,
    description: 'Internal organization ID to associate LinkedIn pages with.',
    example: 'org_12345',
  })
  @ApiResponse({
    status: 200,
    description: 'Authorization URL generated successfully.',
    schema: {
      example:
        'https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=...&redirect_uri=...&state=...&scope=rw_organization_admin',
    },
  })
  async connectPages(
    @Req() req,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.service.getPagesAuthUrl(req.user.id, organizationId);
  }

  @Get('callback')
  @ApiOperation({ summary: 'LinkedIn OAuth callback (code & state)' })
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'state', required: true })
  @ApiResponse({
    status: 200,
    description: 'Social account and discovered pages after successful connect',
    type: CallbackResponseDto,
  })
  async callback(@Query('code') code: string, @Query('state') state: string) {
    return this.service.handleCallback(decodeURIComponent(state), code);
  }

  @Post('pages/connect')
  @ApiOperation({
    summary: 'Connect selected LinkedIn pages to a Rooli SocialAccount',
  })
  @ApiBody({ type: ConnectPagesBodyDto })
  @ApiResponse({
    status: 200,
    description: 'Result of page connections (connected and failed pages).',
    type: ConnectPagesResultDto,
  })
  async connectSelectedPages(@Body() body: ConnectPagesBodyDto) {
    const { socialAccountId, pageUrns } = body;

    return this.service.connectSelectedPages(socialAccountId, pageUrns);
  }

  // GET AVAILABLE PAGES
  @Get('pages/available')
  @ApiOperation({
    summary:
      'List discovered LinkedIn pages available to connect for a SocialAccount',
    description: 'Returns pages discovered for the given socialAccountId.',
  })
  @ApiQuery({
    name: 'socialAccountId',
    required: true,
    description: 'Parent SocialAccount id',
    type: String,
    example: 'cmilwuowv00001eialngkoup4',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of discovered LinkedIn company pages',
    type: LinkedInCompanyPageDto,
    isArray: true,
  })
  async getAvailablePages(@Query('socialAccountId') socialAccountId: string) {
    return this.service.syncPages(socialAccountId);
  }

  // GET CONNECTED PAGES
  @Get('pages/connected')
  @ApiOperation({
    summary:
      'List LinkedIn pages already connected in Rooli for a SocialAccount',
    description:
      'Returns all LinkedIn Company Pages that have already been connected and stored under the given parent SocialAccount.',
  })
  @ApiQuery({
    name: 'socialAccountId',
    required: true,
    description: 'Parent SocialAccount id',
    example: 'cmilwuowv00001eialngkoup4',
  })
  @ApiResponse({
    status: 200,
    description: 'List of connected LinkedIn pages',
    type: ConnectedPageDto,
    isArray: true,
  })
  async getConnectedPages(@Query('socialAccountId') socialAccountId: string) {
    return this.service.getConnectedPages(socialAccountId);
  }

  @Post('refresh/linkedin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh LinkedIn access token',
    description:
      'Refresh LinkedIn OAuth tokens using the stored refresh token. This requires authentication.',
  })
  @ApiBody({
    type: RefreshTokenRequestDto,
    description: 'Refresh token payload',
  })
  @ApiResponse({
    status: 200,
    description: 'LinkedIn tokens refreshed successfully',
  })
  async refreshLinkedInToken(
    @Body('socialAccountId') socialAccountId: string,
  ): Promise<any> {
    return this.service.requestTokenRefresh(socialAccountId);
  }
}
