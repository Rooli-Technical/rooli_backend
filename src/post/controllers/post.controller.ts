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
import { RetryPostDto } from '../dto/request/retry-post.dto';


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
    @CurrentUser() user,
  ) {
    const post = await this.postService.updatePost(user, workspaceId, postId, dto);
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

  @Post('draft')
  @RequirePermission(PermissionResource.POSTS, PermissionAction.CREATE)
  @ApiOperation({ 
    summary: 'Save a post as draft', 
    description: 'Saves a post as a draft in the database.' 
  })
  @ApiParam({ name: 'workspaceId', description: 'The internal Database ID of the workspace' })
  async saveDraft(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdatePostDto,
    @CurrentUser() user,
  ) {
    return this.postService.saveDraft(user, workspaceId, dto);
  }


  @Post('destinations/:destinationId/retry')
  @ApiOperation({ 
    summary: 'Retry a single failed destination',
    description: 'Clones a specific failed destination into a new post and reschedules it.'
  })
  @ApiParam({ name: 'workspaceId', description: 'The ID of the workspace' })
  @ApiParam({ name: 'destinationId', description: 'The ID of the failed PostDestination' })
  @ApiResponse({ 
    status: 201, 
    description: 'Successfully cloned and rescheduled the destination.',
    schema: {
      example: {
        message: 'Created a new post to retry TWITTER destination.',
        originalDestinationId: 'cl_123abc',
        newPostId: 'cl_456xyz',
        platform: 'TWITTER',
        scheduledAt: '2026-04-24T14:30:00.000Z'
      }
    }
  })
  @ApiResponse({ status: 400, description: 'Destination is not in a FAILED state.' })
  @ApiResponse({ status: 404, description: 'Destination not found.' })
  async retryDestination(
    @CurrentUser() user: any,
    @Param('workspaceId') workspaceId: string,
    @Param('destinationId') destinationId: string,
    @Body() dto: RetryPostDto,
  ) {
    return this.postService.retryDestination(
      user, 
      workspaceId, 
      destinationId, 
      dto
    );
  }

  @Post('posts/:postId/retry-failed')
  @ApiOperation({ 
    summary: 'Retry all failed destinations for a post',
    description: 'Clones all failed destinations from a master post into a single new post and reschedules them.'
  })
  @ApiParam({ name: 'workspaceId', description: 'The ID of the workspace' })
  @ApiParam({ name: 'postId', description: 'The ID of the original Master Post' })
  @ApiResponse({ 
    status: 201, 
    description: 'Successfully cloned and rescheduled the failed destinations.',
    schema: {
      example: {
        message: 'Created a new post to retry 2 failed destinations.',
        originalPostId: 'cl_987def',
        newPostId: 'cl_654uvw',
        retriedCount: 2,
        scheduledAt: '2026-04-24T14:30:00.000Z'
      }
    }
  })
  @ApiResponse({ status: 400, description: 'No failed destinations to retry.' })
  @ApiResponse({ status: 404, description: 'Post not found.' })
  async retryAllFailedDestinations(
    @CurrentUser() user: any,
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Body() dto: RetryPostDto,
  ) {
    return this.postService.retryAllFailedDestinations(
      user, 
      workspaceId, 
      postId, 
      dto
    );
  }
}
