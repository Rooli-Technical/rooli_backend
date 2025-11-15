import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { LinkedInService } from './linkedIn.service';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ConnectPagesBodyDto } from './dto/connect-pages.dto';

@ApiTags('LinkedIn - Auth')
@Controller('linkedin/auth')
@ApiBearerAuth()
export class LinkedinController {
  constructor(private readonly service: LinkedInService) {}

  @Get('connect/profile')
  @ApiOperation({
    summary: 'Begin OAuth to connect a personal LinkedIn profile',
  })
  async connectProfile(@Req() req) {
    return this.service.getProfileAuthUrl(req.user.id);
  }

  @Get('connect/pages')
  @ApiOperation({
    summary: 'Begin OAuth to discover and connect LinkedIn Company Pages',
  })
  @ApiQuery({
    name: 'organizationId',
    required: true,
    description: 'Optional internal organization id to associate pages with',
  })
  async connectPages(
    @Req() req,
    @Query('organizationId') organizationId: string,
  ) {
    return this.service.getPagesAuthUrl(organizationId, req.user.id);
  }

  @Get('callback')
  @ApiOperation({ summary: 'LinkedIn OAuth callback (code & state)' })
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'state', required: true })
  async callback(@Query('code') code: string, @Query('state') state: string) {
    return this.service.handleCallback(decodeURIComponent(state), code);
  }

  @Post('pages/connect')
  @ApiOperation({
    summary: 'Connect selected LinkedIn pages to a Rooli SocialAccount',
  })
  @ApiBody({ type: ConnectPagesBodyDto })
  async connectSelectedPages(@Body() body: ConnectPagesBodyDto) {
    const { socialAccountId, pageIds } = body;

    const result = await this.service.connectSelectedPages(
      socialAccountId,
      pageIds,
    );

    return {
      success: true,
      message: `Successfully connected ${result.connectedPages.length} pages`,
      data: result,
    };
  }

  // GET AVAILABLE PAGES
  @Get('pages/available')
  @ApiOperation({
    summary:
      'List discovered LinkedIn pages available to connect for a SocialAccount',
  })
  @ApiQuery({
    name: 'socialAccountId',
    required: true,
    description: 'Parent SocialAccount id',
  })
  async getAvailablePages(@Query('socialAccountId') socialAccountId: string) {
    return this.service.syncPages(socialAccountId);
  }

  // GET CONNECTED PAGES
  @Get('pages/connected')
  @ApiOperation({
    summary:
      'List LinkedIn pages already connected in Rooli for a SocialAccount',
  })
  @ApiQuery({
    name: 'socialAccountId',
    required: true,
    description: 'Parent SocialAccount id',
  })
  async getConnectedPages(@Query('socialAccountId') socialAccountId: string) {
    return this.service.getConnectedPages(socialAccountId);
  }

}
