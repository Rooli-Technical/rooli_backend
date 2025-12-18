import {
  Controller,
  Post,
  Param,
  Body,
  Get,
  Delete,
  Req,
} from '@nestjs/common';
import { InviteMemberDto } from './dtos/invite-member.dto';
import { InvitationsService } from './invitations.service';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { OrgAuth } from '@/common/decorators/auth.decorator';

@ApiTags('Organization Invitations')
@ApiBearerAuth()
@Controller()
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post('organizations/:orgId/invitations')
  @OrgAuth({ resource: 'MEMBERS', action: 'MANAGE' })
  @ApiOperation({ summary: 'Invite a new member to the organization' })
  @ApiResponse({ status: 201, description: 'Invitation created successfully' })
  @ApiResponse({
    status: 400,
    description: 'Member limit reached or invalid data',
  })
  @ApiResponse({
    status: 409,
    description: 'User already invited or already a member',
  })
  async inviteMember(
    @Param('orgId') orgId: string,
    @Req() req: any,
    @Body() dto: InviteMemberDto,
  ) {
    return this.invitationsService.inviteMember(orgId, req.user.id, dto);
  }

  @Post('invitations/accept/:token')
  @ApiOperation({ summary: 'Accept an invitation' })
  @ApiResponse({
    status: 200,
    description: 'Invitation accepted, membership created',
  })
  @ApiResponse({
    status: 400,
    description: 'Invitation already processed or expired',
  })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async acceptInvitation(@Param('token') token: string, @Req() req: any) {
    return this.invitationsService.acceptInvitation(token, 'cmiraqm38000go4iaeomi1pz7');
  }

  @Post('invitations/:id/resend')
  @ApiOperation({ summary: 'Resend an invitation email' })
  @ApiResponse({ status: 200, description: 'Invitation resent successfully' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async resendInvitation(@Param('id') invitationId: string) {
    return this.invitationsService.resendInvitation(invitationId);
  }

  @Post(':token/decline')
  @ApiOperation({ summary: 'Decline an organization invitation' })
  @ApiResponse({ status: 200, description: 'Invitation successfully declined' })
  declineInvitation(@Param('token') token: string, @Req() req: any) {
    return this.invitationsService.declineInvitation(token);
  }

  @Delete('invitations/:id/revoke')
  @ApiOperation({ summary: 'Revoke an invitation' })
  @ApiResponse({ status: 200, description: 'Invitation revoked successfully' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async revokeInvitation(@Param('id') invitationId: string, @Req() req: any) {
    return this.invitationsService.revokeInvitation(invitationId);
  }

  @Get('organizations/:orgId/invitations')
  @ApiOperation({ summary: 'Get all invitations for an organization' })
  @ApiResponse({ status: 200, description: 'List of invitations' })
  async getOrganizationInvitations(@Param('orgId') orgId: string) {
    return this.invitationsService.getOrganizationInvitations(orgId);
  }
}
