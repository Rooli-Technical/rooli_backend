import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  Request,
  Delete,
  Patch,
  Query,
} from '@nestjs/common';
import { PostService } from '../services/post.service';
import { RequireFeature } from '@/common/decorators/require-feature.decorator';
import { FeatureGuard } from '@/common/guards/feature.guard';
import { CreatePostDto } from '../dto/request/create-post.dto';
import { ApiStandardResponse } from '@/common/decorators/api-standard-response.decorator';
import { ApiOperation, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { BulkExecuteResponseDto } from '../dto/response/bulk-execute.response.dto';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { UpdatePostDto } from '../dto/request/update-post.dto';
import { PostDto } from '../dto/response/post.dto';
import { ApiPaginatedResponse } from '@/common/decorators/api-paginated-response.decorator';
import { GetWorkspacePostsDto } from '../dto/request/get-all-posts.dto';
import { BulkCreatePostDto } from '../dto/request/bulk-schedule.dto';
import { ContextGuard } from '@/common/guards/context.guard';
import { PermissionsGuard } from '@/common/guards/permission.guard';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { PermissionResource, PermissionAction } from '@generated/enums';

@Controller('workspaces/:workspaceId/posts')
@ApiBearerAuth()
@UseGuards(ContextGuard, PermissionsGuard, FeatureGuard)
export class PostController {
  constructor(private readonly postService: PostService) {}

  @Post()
  @RequirePermission(PermissionResource.POSTS, PermissionAction.CREATE)
  @ApiOperation({ summary: 'Create a new post in the workspace' })
  @ApiStandardResponse(PostDto)
  async create(
    @Request() req,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreatePostDto,
  ) {
    return this.postService.createPost(req.user, workspaceId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all posts in the workspace' })
  @ApiPaginatedResponse(PostDto)
  async findAll(@Param('workspaceId') workspaceId: string, @Query() query: GetWorkspacePostsDto,) {
    return this.postService.getWorkspacePosts(workspaceId, query);
  }


  @Get(':postId')
  @ApiOperation({ summary: 'Get a single post by ID' })
  @ApiStandardResponse(PostDto)
  async getOne(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
  ) {
    const post = await this.postService.getOne(workspaceId, postId);
    return { data: post };
  }

  @Patch(':postId')
  @ApiOperation({ summary: 'Update a post by ID' })
  @ApiStandardResponse(PostDto)
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Body() dto: UpdatePostDto,
  ) {
    const post = await this.postService.updatePost(workspaceId, postId, dto);
    return { data: post };
  }

  @Delete(':postId')
  @ApiOperation({ summary: 'Delete a post by ID (including its thread children)' })
  @ApiStandardResponse(PostDto)
  async delete(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
  ) {
    const result = await this.postService.deletePost(workspaceId, postId);
    return { data: result };
  }

  @Post('bulk/execute')
  @RequireFeature('bulkScheduling')
  @ApiOperation({
    summary: 'Execute bulk schedule after CSV validation',
    description: 'Creates scheduled posts and destinations in the workspace.',
  })
  @ApiParam({ name: 'workspaceId', example: 'cmjy3lnu50002m4iaj3fuj7so' })
  @ApiStandardResponse(BulkExecuteResponseDto)
  async executeBulkSchedule(
    @Param('workspaceId') workspaceId: string,
    @Body() body: BulkCreatePostDto,
    @CurrentUser() user,
  ) {
    return this.postService.bulkSchedulePosts(user, workspaceId, body);
  }
}
