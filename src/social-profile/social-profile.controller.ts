import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SocialProfileService } from './social-profile.service';
import { WorkspaceAuth } from '@/common/decorators/auth.decorator';
import { BulkAddProfilesDto } from './dto/request/bulk-add-profile.dto';
import { ApiStandardResponse } from '@/common/decorators/api-standard-response.decorator';
import { BulkAddProfilesResponseDto } from './dto/response/add-profile-response.dto';

@ApiTags('Workspace Social Profiles')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/social-profiles')
export class SocialProfileController {
  constructor(private readonly profileService: SocialProfileService) {}

  @Post()
  @ApiOperation({
    summary: 'Bulk Add social profiles to workspace',
    description:
      'Links a social page/profile (e.g Facebook Page, Instagram Business) to a workspace.',
  })
  @ApiParam({
    name: 'workspaceId',
    example: 'ws_abc123',
  })
@ApiStandardResponse(BulkAddProfilesResponseDto)
  //@WorkspaceAuth({ resource: 'SOCIAL_ACCOUNT', action: 'CREATE' })
  async addProfile(
    @Param('workspaceId') workspaceId: string,
    @Body() body: BulkAddProfilesDto,
  ) {
    return this.profileService.addProfilesToWorkspace(workspaceId, body);
  }

   @Get()
  @ApiOperation({
    summary: 'List workspace social profiles',
    description:
      'Returns all social media profiles connected to a workspace.',
  })
  @ApiParam({
    name: 'workspaceId',
    example: 'ws_abc123',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'profile_123',
          platform: 'FACEBOOK',
          name: 'My Business Page',
        },
      ],
    },
  })
  //@WorkspaceAuth({ resource: 'SOCIAL_ACCOUNT', action: 'READ' })
  async listProfiles(@Param('workspaceId') workspaceId: string) {
    return this.profileService.getWorkspaceProfiles(workspaceId);
  }

  @Delete(':profileId')
  @ApiOperation({
    summary: 'Remove social profile from workspace',
    description:
      'Unlinks a social profile from the workspace without deleting the master connection.',
  })
  @ApiParam({
    name: 'workspaceId',
    example: 'ws_abc123',
  })
  @ApiParam({
    name: 'profileId',
    example: 'profile_123',
  })
  @ApiOkResponse({
    schema: {
      example: {
        message: 'Profile removed successfully',
      },
    },
  })
  //@WorkspaceAuth({ resource: 'SOCIAL_ACCOUNT', action: 'DELETE' })
  async removeProfile(
    @Param('workspaceId') workspaceId: string,
    @Param('profileId') profileId: string,
  ) {
    return this.profileService.removeProfile(workspaceId, profileId);
  }
}
