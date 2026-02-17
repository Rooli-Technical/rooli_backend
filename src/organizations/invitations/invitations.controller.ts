import { 
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards 
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { InvitationsService } from './invitations.service';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { ContextGuard } from '@/common/guards/context.guard';
import { PermissionsGuard } from '@/common/guards/permission.guard';
import { PermissionResource, PermissionAction } from '@generated/enums';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { CreateInviteDto } from './dtos/invite-member.dto';


@ApiTags('Invitations')
@ApiBearerAuth()
@UseGuards(ContextGuard, PermissionsGuard)
@Controller('organizations/:organizationId/invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post()
  @RequirePermission(PermissionResource.INVITATIONS, PermissionAction.CREATE)
  @ApiOperation({ summary: 'Invite a user', description: 'Sends an email invitation to a new or existing user.' })
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
  @ApiOperation({ summary: 'Resend an invitation', description: 'Regenerates the token and resets the 7-day expiry.' })
  async resend(@Param('invitationId') invitationId: string) {
    return this.invitationsService.resendInvitation(invitationId);
  }

  @Delete(':invitationId')
  @RequirePermission(PermissionResource.INVITATIONS, PermissionAction.DELETE)
  @ApiOperation({ summary: 'Revoke an invitation' })
  async revoke(@Param('invitationId') invitationId: string) {
    return this.invitationsService.revokeInvitation(invitationId);
  }
}