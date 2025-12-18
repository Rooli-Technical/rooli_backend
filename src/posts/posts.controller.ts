import {
  Controller,
  Post,
  Body,
  Param,
  Get,
  Query,
  Delete,
  ForbiddenException,
  UseGuards,
  HttpCode,
  HttpStatus,
  Patch,
  Req,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { PostFilterDto } from './dto/post-filter.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { Platform } from '@generated/enums';

@ApiTags('Posts')
@ApiBearerAuth()
@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  /**
   * Create a new draft post
   */
  @Post()
  @ApiOperation({
    summary: 'Create a new draft post',
    description:
      'Creates a new post as DRAFT. Every post must be approved before scheduling or publishing.',
  })
  @ApiResponse({ status: 201, description: 'Post created successfully' })
  @ApiResponse({
    status: 400,
    description: 'Invalid data or platform mismatch',
  })
  async createPost(
    @Req() req,
    @Body() dto: CreatePostDto,
  ) {
    return this.postsService.createPost(req.user.id, req.user.orgId, dto);
  }

  /**
   * Submit a draft post for approval
   */
  @Post(':id/submit')
  @ApiOperation({
    summary: 'Submit draft post for approval',
    description:
      'Moves a draft post to PENDING_APPROVAL and triggers approval workflow.',
  })
  @ApiResponse({ status: 200, description: 'Post submitted for approval' })
  async submitForApproval(
    @Req() req,
    @Param('id') postId: string,
  ) {
    return this.postsService.submitForApproval(
      postId,
      req.user.id,
    );
  }

  /**
   * Get all posts (with filters)
   */
  @Get(':organizationId')
  @ApiOperation({
    summary: 'Get all organization posts',
    description:
      'Retrieves posts for the current organization with filters and pagination.',
  })
  @ApiResponse({ status: 200, description: 'List of posts with pagination' })
  async getOrganizationPosts(
    @Param('organizationId') organizationId: string,
    @Query() filters: PostFilterDto,
  ) {
    return this.postsService.getOrganizationPosts(organizationId, filters);
  }

  /**
   * Get a single post by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get post details by ID',
    description:
      'Fetch a specific post by its ID along with social account and approval info.',
  })
  @ApiResponse({
    status: 200,
    description: 'Post details retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async getPostById(
    @Param('id') postId: string,
  ) {
    return this.postsService.getPostById(postId);
  }

  /**
   * Update a post (only drafts, failed, or pending approval)
   */
  @Patch(':id')
  @ApiOperation({
    summary: 'Update a post',
    description:
      'Updates the content or schedule of a post that is in DRAFT, FAILED, or PENDING_APPROVAL state.',
  })
  @ApiResponse({ status: 200, description: 'Post updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid update request' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async updatePost(
    @Param('id') postId: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.postsService.updatePost(postId, dto);
  }

  /**
   * Delete a post (only drafts, failed, or canceled)
   */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a post',
    description:
      'Deletes a post permanently. Only posts in DRAFT, FAILED, or CANCELED status can be deleted.',
  })
  @ApiResponse({ status: 204, description: 'Post deleted successfully' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePost(
    @Param('id') postId: string,
  ) {
    await this.postsService.deletePost(postId);
  }
}
