import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { InvitationsService } from '../invitations.service';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { ContextGuard } from '@/common/guards/context.guard';
import { PermissionsGuard } from '@/common/guards/permission.guard';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { CreateInviteDto } from '../dtos/invite-member.dto';
import { PermissionAction, PermissionResource } from '@/common/constants/rbac';
import { AcceptInviteDto } from '../dtos/accept-invite.dto';
import { Public } from '@/common/decorators/public.decorator';


@ApiTags('Invitations')
@ApiBearerAuth()
@UseGuards(ContextGuard, PermissionsGuard)
@Controller('organizations/:organizationId/invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post()
  @RequirePermission(PermissionResource.INVITATIONS, PermissionAction.CREATE)
  @ApiOperation({
    summary: 'Invite a user',
    description: 'Sends an email invitation to a new or existing user.',
  })
  async invite(
    @Param('organizationId') organizationId: string,
    @CurrentUser('userId') inviterId: string,
    @Body() dto: CreateInviteDto,
  ) {
    return this.invitationsService.inviteUser({
      inviterId,
      organizationId,
      email: dto.email,
      roleId: dto.roleId,
      workspaceId: dto.workspaceId,
    });
  }

  @Get()
  @RequirePermission(PermissionResource.INVITATIONS, PermissionAction.READ)
  @ApiOperation({ summary: 'List pending invitations' })
  async list(@Param('organizationId') organizationId: string) {
    return this.invitationsService.getPendingInvitations(organizationId);
  }

  @Patch(':invitationId/resend')
  @RequirePermission(PermissionResource.INVITATIONS, PermissionAction.UPDATE)
  @ApiOperation({
    summary: 'Resend an invitation',
    description: 'Regenerates the token and resets the 7-day expiry.',
  })
  async resend(
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.invitationsService.resendInvitation(invitationId);
  }

  @Delete(':invitationId')
  @RequirePermission(PermissionResource.INVITATIONS, PermissionAction.DELETE)
  @ApiOperation({ summary: 'Revoke an invitation' })
  async revoke(
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.invitationsService.revokeInvitation(invitationId);
  }

  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'Get invitation details before accepting' })
  @ApiResponse({
    status: 200,
    description: 'Details of the organization, workspace, and role.',
  })
  @ApiResponse({ status: 400, description: 'Token is invalid or expired.' })
  async getDetails(@Param('token') token: string) {
    return this.invitationsService.getInviteDetails(token);
  }

  @Public()
  @Post(':token/accept')
  @ApiOperation({
    summary: 'Accept an invitation and create an account if needed',
  })
  @ApiResponse({
    status: 201,
    description: 'Returns auth tokens and user object.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid token or missing required fields for new user.',
  })
  async accept(@Param('token') token: string, @Body() dto: AcceptInviteDto) {
    return this.invitationsService.acceptInvite(token, dto);
  }
}
