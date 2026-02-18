import { RequireFeature } from "@/common/decorators/require-feature.decorator";
import { FeatureGuard } from "@/common/guards/feature.guard";
import { Controller, UseGuards, Get, Param, Patch, Body, Delete, Req, Query } from "@nestjs/common";
import { PostService } from "../services/post.service";
import { ApiPaginatedResponse } from "@/common/decorators/api-paginated-response.decorator";
import { PaginationDto } from "@/common/dtos/pagination.dto";
import { PostApprovalDto } from "../dto/response/post-approval.dto";
import { ReviewApprovalDto } from "../dto/response/review-approval.dto";
import { ApiStandardResponse } from "@/common/decorators/api-standard-response.decorator";
import { ApiBearerAuth } from "@nestjs/swagger";
import { AuditContext } from "@/audit/decorators/audit.decorator";
import { AuditAction, AuditResourceType } from "@generated/enums";

@Controller('workspaces/:workspaceId/approvals')
@ApiBearerAuth()
@UseGuards(FeatureGuard)
@RequireFeature('approvalWorkflow') 
export class PostApprovalController {
  constructor(private readonly postService: PostService) {}

@ApiPaginatedResponse(PostApprovalDto)
@Get()
findAll(
  @Param('workspaceId') wsId: string,
  @Query() query: PaginationDto,
) {
  return this.postService.getPendingApprovals(wsId, query);
}


@ApiStandardResponse(PostApprovalDto)
@AuditContext({ action: AuditAction.APPROVE, resource: AuditResourceType.POST })
  @Patch(':approvalId')
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
  @AuditContext({ action: AuditAction.DELETE, resource: AuditResourceType.POST })
  cancel(
    @Req() req,
    @Param('workspaceId') wsId: string,
    @Param('approvalId') approvalId: string,
  ) {
    return this.postService.cancelApprovalRequest(
      req.user,
      wsId,
      approvalId,
    );
  }
}