import { Controller, Get, HttpCode, HttpStatus, Query, Req } from '@nestjs/common';
import { TwitterService } from './twitter.service';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StartAuthResponseDto } from './dto/start-auth-response.dto';
import { CallbackQueryDto } from './dto/callback-query.dto';

@ApiTags('Twitter - Auth')
@ApiBearerAuth()
@Controller('x/auth')
export class TwitterController {
  constructor(private readonly service: TwitterService) {}

  @Get('connect')
  @ApiOperation({
    summary: 'Start Twitter OAuth flow (generate authorization URL)',
    description:
      'Generates a Twitter auth URL and stores temporary oauth context in Redis. ' +
      'Authenticated user is required'
  })
   @ApiQuery({
    name: 'organizationId',
    required: false,
    description: 'Optional internal organization id to associate the eventual connection with',
    type: String,
    example: 'org_12345',
  })
  @ApiOkResponse({
    description: 'Auth URL and temporary oauth token',
    type: StartAuthResponseDto,
  })
  async connectProfile(@Req() req,  @Query('organizationId') organizationId?: string,): Promise<StartAuthResponseDto> 
  {
    return this.service.startAuth(organizationId, req.user.id);
  }

  @Get('callback')
  @HttpCode(HttpStatus.OK)
 @ApiOperation({
    summary: 'Twitter OAuth callback (oauth_token & oauth_verifier)',
    description:
      'Twitter redirects to this endpoint after user authorization. The controller exchanges the verifier for tokens and returns the connected social account and profile.',
  })
  @ApiQuery({ name: 'oauth_token', required: true })
  @ApiQuery({ name: 'oauth_verifier', required: true })
  @ApiResponse({
    status: 200,
    description: 'Connected social account and profile',
    //type: CallbackResponseDto,
  })
  async callback(@Query() query: CallbackQueryDto) {
    const { oauth_token, oauth_verifier } = query;

   return this.service.handleOAuthCallback(
      oauth_token,
      oauth_verifier,
    );
  }
}
