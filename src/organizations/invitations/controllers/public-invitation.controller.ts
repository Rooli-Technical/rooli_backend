import { Controller, Get, Param, Post, Body } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AcceptInviteDto } from "../dtos/accept-invite.dto";
import { InvitationsService } from "../invitations.service";
import { Public } from "@/common/decorators/public.decorator";

@ApiTags('Invitations (Public)')
@Controller('invitations') 
export class PublicInvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  
  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'Get invitation details before accepting' })
  @ApiResponse({ status: 200, description: 'Details of the organization, workspace, and role.' })
  @ApiResponse({ status: 400, description: 'Token is invalid or expired.' })
  async getDetails(@Param('token') token: string) {
    return this.invitationsService.getInviteDetails(token);
  }

  @Public()
  @Post(':token/accept')
  @ApiOperation({ summary: 'Accept an invitation and create an account if needed' })
  @ApiResponse({ status: 201, description: 'Returns auth tokens and user object.' })
  @ApiResponse({ status: 400, description: 'Invalid token or missing required fields for new user.' })
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInviteDto,
  ) {
    return this.invitationsService.acceptInvite(token, dto);
  }
}