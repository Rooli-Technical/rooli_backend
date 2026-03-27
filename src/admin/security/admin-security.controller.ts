// admin-security.controller.ts
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';

import { AdminSecurityService } from './admin-security.service';
import {
  AddIpDto,
  AdminSecurityOverviewDto,
  MessageDto,
} from './admin-security.dto';
import { AdminRoute } from '@/common/decorators/admin-route.decorator';
import { AdminJwtGuard } from '../guards/admin-jwt.guard';

@ApiTags('Admin-Security')
@ApiBearerAuth()
@AdminRoute()
@UseGuards(AdminJwtGuard)
@Controller('admin/security')
export class AdminSecurityController {
  constructor(private readonly service: AdminSecurityService) {}

  @Get()
  @ApiOperation({ summary: 'Get admin security overview' })
  @ApiResponse({ status: 200, type: AdminSecurityOverviewDto })
  async getOverview(@Req() req): Promise<AdminSecurityOverviewDto> {
    return this.service.getSecurityOverview(req.user.id);
  }

  @Post('ip')
  @ApiOperation({ summary: 'Add IP to whitelist' })
  @ApiResponse({ status: 200, type: MessageDto })
  async addIp(@Req() req, @Body() dto: AddIpDto): Promise<MessageDto> {
    await this.service.addWhitelistIp(req.user.userId, dto.ipRange);
    return { message: 'IP added successfully' };
  }

  @Delete('ip/:id')
  @ApiOperation({ summary: 'Remove IP from whitelist' })
  @ApiResponse({ status: 200, type: MessageDto })
  async removeIp(@Param('id') id: string): Promise<MessageDto> {
    await this.service.removeWhitelistIp(id);
    return { message: 'IP removed successfully' };
  }

  @Post('session/:sessionId/revoke')
  @ApiOperation({ summary: 'Revoke a session' })
  @ApiResponse({ status: 200, type: MessageDto })
  async revokeSession(
    @Param('sessionId') sessionId: string,
  ): Promise<MessageDto> {
    await this.service.revokeSession(sessionId);
    return { message: 'Session revoked' };
  }

  @Post('sessions/revoke-others')
  @ApiOperation({ summary: 'Revoke all other sessions' })
  @ApiResponse({ status: 200, type: MessageDto })
  async revokeOthers(@Req() req): Promise<MessageDto> {
    await this.service.revokeOtherSessions(req.user.id, req.user.sessionId);

    return { message: 'Other sessions revoked' };
  }

  @Post('rotate-tokens')
  @ApiOperation({ summary: 'Rotate tokens (invalidate all sessions)' })
  @ApiResponse({ status: 200, type: MessageDto })
  async rotateTokens(@Req() req): Promise<MessageDto> {
    await this.service.rotateTokens(req.user.id);
    return { message: 'Tokens rotated successfully' };
  }
}
