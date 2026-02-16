import {
  Controller,
  Post,
  Param,
  Body,
  Get,
  Delete,
  Req,
  Query,
} from '@nestjs/common';
import { InviteUserDto } from './dtos/invite-member.dto';
import { InvitationsService } from './invitations.service';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { AcceptInviteDto } from './dtos/accept-invite.dto';
import { Public } from '@/common/decorators/public.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';

@ApiTags('Invitations')
@ApiBearerAuth()
@Controller()
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}


  @Post('invitations/accept')
  @Public() 
  @ApiOperation({ summary: 'Accept an invitation' })
  @ApiResponse({ status: 201, description: 'User created/linked and logged in.' })
  async acceptInvite(
    @Query('token') token: string,
    @Body() body: AcceptInviteDto 
  ) {
    return this.invitationsService.acceptInvite(token, body);
  }



  @Post('organizations/:organizationId/invitations')
  //@OrgAuth({ resource: 'MEMBERS', action: 'CREATE' })
  @ApiOperation({ summary: 'Invite a member to the Organization (No Workspace)' })
  async inviteToOrg(
    @Param('organizationId') orgId: string,
    @Body() body: InviteUserDto,
    @CurrentUser('id') userId: string
  ) {
    return this.invitationsService.inviteUser(
      userId,
      orgId,
      body.email,
      body.roleId,
      null 
    );
  }

  @Get('organizations/:organizationId/invitations')
  //@OrgAuth({ resource: 'MEMBERS', action: 'READ' })
  @ApiOperation({ summary: 'List pending organization invites' })
  async listOrgInvites(@Param('organizationId') orgId: string) {
    return this.invitationsService.getPendingInvitations(orgId);
  }

  // ===========================================================================
  // 3. WORKSPACE INVITES (Team Members, Editors)
  // ===========================================================================

  @Post('workspaces/:workspaceId/invitations')
  //@WorkspaceAuth({ resource: 'MEMBERS', action: 'CREATE' })
  @ApiOperation({ summary: 'Invite a member to a specific Workspace' })
  async inviteToWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Body() body: InviteUserDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('organizationId') orgId: string // ContextGuard populated this!
  ) {
    return this.invitationsService.inviteUser(
      userId,
      orgId,
      body.email,
      body.roleId,
      workspaceId 
    );
  }
}