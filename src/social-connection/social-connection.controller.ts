import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { SocialConnectionService } from './social-connection.service';
import { Platform } from '@generated/enums';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiOkResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SocialCallbackDto } from './dto/callback-dto';

@ApiTags('Social Connections')
@ApiBearerAuth()
@Controller('social-connections')
export class SocialConnectionController {
  constructor(
    private readonly socialConnectionService: SocialConnectionService,
  ) {}

  /**
   * GET AUTH URL
   */
  @Get('auth-url')
  @ApiOperation({
    summary: 'Generate OAuth authorization URL',
    description:
      'Returns a redirect URL to the social platform OAuth consent screen.',
  })
  @ApiQuery({
    name: 'platform',
    enum: Platform,
    example: 'FACEBOOK',
  })
  @ApiQuery({
    name: 'organizationId',
    example: 'org_abc123',
  })
  @ApiOkResponse({
    schema: {
      example: {
        url: 'https://www.facebook.com/v19.0/dialog/oauth?...',
      },
    },
  })
  async getAuthUrl(
    @Query('platform') platform: Platform,
    @Query('organizationId') organizationId: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('organizationId is required');
    }

    const url = await this.socialConnectionService.getAuthUrl(
      platform,
      organizationId,
    );

    return { url };
  }

  /**
   * OAUTH CALLBACK
   */
  @Get('callback/:platform')
  @ApiOperation({
    summary: 'Handle OAuth callback',
    description:
      'Exchanges authorization code for tokens, stores connection, and returns importable pages.',
  })
  @ApiParam({
    name: 'platform',
    enum: Platform,
    example: 'FACEBOOK',
  })
  @ApiOkResponse({
    schema: {
      example: {
        message: 'Connection successful',
        connectionId: 'conn_123456',
        availablePages: [
          {
            id: '123456789',
            name: 'My Business Page',
            platform: 'FACEBOOK',
            type: 'PAGE',
          },
        ],
      },
    },
  })
  async handleCallback(
    @Param('platform') platform: Platform,
    @Query() query: SocialCallbackDto,
  ) {
    if (platform === Platform.TWITTER) {
      const { oauth_token, oauth_verifier } = query;

      if (!oauth_token || !oauth_verifier) {
        throw new BadRequestException(
          'Missing Twitter OAuth token or verifier',
        );
      }
      return this.socialConnectionService.handleCallback(platform, {
        token: oauth_token,
        verifier: oauth_verifier,
      });
    }

    //  Logic for OAuth 2.0 (Facebook, LinkedIn, etc.)
    else {
      const { code, state } = query;

      if (!code || !state) {
        throw new BadRequestException('Missing OAuth code or state');
      }

      return this.socialConnectionService.handleCallback(platform, {
        code,
        state,
      });
    }
  }

  /**
   * GET IMPORTABLE PAGES
   */
  @Get(':connectionId/pages')
  @ApiOperation({
    summary: 'Get importable social pages',
    description: 'Returns pages/accounts that can be linked to a workspace.',
  })
  @ApiParam({
    name: 'connectionId',
    example: 'conn_123456',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: '987654321',
          name: 'Instagram Business',
          platform: 'FACEBOOK',
          type: 'INSTAGRAM',
        },
      ],
    },
  })
  getImportablePages(@Param('connectionId') connectionId: string) {
    return this.socialConnectionService.getImportablePages(connectionId);
  }

  /**
   * DISCONNECT
   */
  @Delete(':connectionId')
  @ApiOperation({
    summary: 'Disconnect social account',
    description:
      'Deletes the social connection and unlinks all associated profiles.',
  })
  @ApiParam({
    name: 'connectionId',
    example: 'conn_123456',
  })
  @ApiQuery({
    name: 'organizationId',
    example: 'org_abc123',
  })
  @ApiOkResponse({
    schema: {
      example: {
        message: 'Connection removed and associated profiles unlinked.',
      },
    },
  })
  disconnect(
    @Param('connectionId') connectionId: string,
    @Query('organizationId') organizationId: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('organizationId is required');
    }

    return this.socialConnectionService.disconnect(
      connectionId,
      organizationId,
    );
  }
}
