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
  Req,
} from '@nestjs/common';
import { PostService } from '../services/post.service';
import { CreatePostDto } from '../dto/request/create-post.dto';
import { ApiStandardResponse } from '@/common/decorators/api-standard-response.decorator';
import {
  ApiQuery,
  ApiOperation,
  ApiParam,
  ApiBearerAuth,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
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
import { PermissionResource, PermissionAction } from '@/common/constants/rbac';
import { CreateDraftDto } from '../dto/request/create-draft.dto';


@Controller('workspaces/:workspaceId/posts')
@ApiBearerAuth()
@UseGuards(ContextGuard, PermissionsGuard)
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
  @RequirePermission(PermissionResource.POSTS, PermissionAction.READ)
  @ApiOperation({ summary: 'Get all posts in the workspace' })
  @ApiPaginatedResponse(PostDto)
  async findAll(
    @Param('workspaceId') workspaceId: string,
    @Query() query: GetWorkspacePostsDto,
  ) {
    return this.postService.getWorkspacePosts(workspaceId, query);
  }

  @Get('metrics')
  @RequirePermission(PermissionResource.ANALYTICS, PermissionAction.READ)
  @ApiOperation({ summary: 'List all posts with metrics' })
  @ApiQuery({ name: 'take', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Returns threaded comments' })
  async listPosts(
    @Param('workspaceId') workspaceId: string,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.postService.listPostsWithMetrics({
      workspaceId,
      take: take ? parseInt(take, 10) : 50,
      cursor,
    });
  }

  @Get(':postId')
  @RequirePermission(PermissionResource.POSTS, PermissionAction.READ)
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
  @RequirePermission(PermissionResource.POSTS, PermissionAction.UPDATE)
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
  @RequirePermission(PermissionResource.POSTS, PermissionAction.DELETE)
  @ApiOperation({
    summary: 'Delete a post by ID (including its thread children)',
  })
  @ApiStandardResponse(PostDto)
  async delete(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
  ) {
    const result = await this.postService.deletePost(workspaceId, postId);
    return { data: result };
  }

  @Post('bulk/execute')
  @RequirePermission(PermissionResource.POSTS, PermissionAction.CREATE)
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

  @Patch(':postId/edit')
  @RequirePermission(PermissionResource.POSTS, PermissionAction.UPDATE)
  @ApiOperation({ 
    summary: 'Edit a published post content', 
    description: 'Updates the content of a post already published to external platforms. Currently supports Facebook only.' 
  })
  @ApiParam({ name: 'id', description: 'The internal Database ID of the post' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        newContent: {
          type: 'string',
          example: 'Updating my status with some fresh info!',
        },
      },
      required: ['newContent'],
    },
  })
  async editPost(
    @Param('postId') postId: string,
    @Body('newContent') newContent: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.postService.editPublishedPost(workspaceId, postId, newContent);
  }

  @Delete(':postId/remote')
  @RequirePermission(PermissionResource.POSTS, PermissionAction.DELETE)
  @ApiOperation({ 
    summary: 'Delete a published post from platforms', 
    description: 'Deletes the post from external social media platforms (Facebook) and marks it as deleted in the database.' 
  })
  @ApiParam({ name: 'postId', description: 'The internal Database ID of the post' })
  async deleteRemotePost(
    @Param('postId') postId: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.postService.deletePublishedPost(workspaceId, postId);
  }
}
