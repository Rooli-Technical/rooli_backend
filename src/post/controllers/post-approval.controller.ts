import { RequireFeature } from '@/common/decorators/require-feature.decorator';
import { FeatureGuard } from '@/common/guards/feature.guard';
import {
  Controller,
  UseGuards,
  Get,
  Param,
  Patch,
  Body,
  Delete,
  Req,
  Query,
} from '@nestjs/common';
import { PostService } from '../services/post.service';
import { ApiPaginatedResponse } from '@/common/decorators/api-paginated-response.decorator';
import { PaginationDto } from '@/common/dtos/pagination.dto';
import { PostApprovalDto } from '../dto/response/post-approval.dto';
import { ReviewApprovalDto } from '../dto/response/review-approval.dto';
import { ApiStandardResponse } from '@/common/decorators/api-standard-response.decorator';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuditContext } from '@/audit/decorators/audit.decorator';
import { AuditAction, AuditResourceType } from '@generated/enums';
import { PermissionsGuard } from '@/common/guards/permission.guard';
import { ContextGuard } from '@/common/guards/context.guard';
import { PermissionResource, PermissionAction } from '@/common/constants/rbac';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';

@Controller('workspaces/:workspaceId/approvals')
@ApiBearerAuth()
@UseGuards(ContextGuard, PermissionsGuard, FeatureGuard)
@RequireFeature('approvalWorkflow')
export class PostApprovalController {
  constructor(private readonly postService: PostService) {}

  @ApiOperation({
    summary: 'Get pending approvals',
    description: 'Returns all pending approvals for the workspace',
  })
  @ApiPaginatedResponse(PostApprovalDto)
  @Get()
  @RequirePermission(PermissionResource.APPROVAL, PermissionAction.READ)
  findAll(@Param('workspaceId') wsId: string, @Query() query: PaginationDto) {
    return this.postService.getPendingApprovals(wsId, query);
  }

  @ApiStandardResponse(PostApprovalDto)
  @ApiOperation({
    summary: 'Review an approval',
    description: 'Approves or rejects an approval request',
  })
  @RequirePermission(PermissionResource.APPROVAL, PermissionAction.APPROVE)
  @AuditContext({
    action: AuditAction.APPROVE,
    resource: AuditResourceType.POST,
  })
  @Patch(':approvalId')
  @RequirePermission(PermissionResource.APPROVAL, PermissionAction.MANAGE)
  review(
    @Req() req,
    @Param('workspaceId') wsId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: ReviewApprovalDto,
  ) {
    return this.postService.reviewApproval(
      req.user.userId,
      wsId,
      approvalId,
      body.status,
      body.notes,
    );
  }

  @Delete(':approvalId')
  @ApiOperation({
    summary: 'Cancel an approval',
    description: 'Cancels an approval request',
  })
  @RequirePermission(PermissionResource.APPROVAL, PermissionAction.MANAGE)
  @AuditContext({
    action: AuditAction.DELETE,
    resource: AuditResourceType.POST,
  })
  cancel(
    @Req() req,
    @Param('workspaceId') wsId: string,
    @Param('approvalId') approvalId: string,
  ) {
    return this.postService.cancelApprovalRequest(req.user.userId, wsId, approvalId);
  }
}
