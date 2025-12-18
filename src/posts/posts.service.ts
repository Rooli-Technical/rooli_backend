import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePostDto } from './dto/create-post.dto';
import { PostFilterDto } from './dto/post-filter.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { fromZonedTime } from 'date-fns-tz';
import { HttpService } from '@nestjs/axios';
import { ApprovalsService } from '@/approvals/approvals.service';
import { EncryptionService } from '@/common/utility/encryption.service';
import { MediaService } from '@/media/media.service';
import { Prisma } from '@generated/client';
import { PostStatus, Platform } from '@generated/enums';

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);
  private readonly MAX_RETRIES = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalsService: ApprovalsService,
    private readonly mediaService: MediaService,
    private readonly encryptionService: EncryptionService,
    private readonly http: HttpService,
  ) {}

  /**
   * Create a new post
   */
  async createPost(userId: string, orgId: string,dto: CreatePostDto) {
    try {
      await this.validatePostCreation(userId, dto);

      // find the organization to get timezone
      const organization = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { timezone: true },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      const timezone = organization.timezone;

      // 2. Determine if this is a profile post or page post
      const isProfilePost = !dto.pageAccountId;

      return this.prisma.$transaction(async (tx) => {
        const mediaFileIds = dto.mediaFileIds ?? [];

        let finalScheduledAt: Date | null = null;

        if (dto.scheduledAt && timezone) {
          finalScheduledAt = this.calculateUtcTime(
            dto.scheduledAt,
            timezone,
          );
          if (finalScheduledAt <= new Date()) {
            throw new BadRequestException(
              'Scheduled time must be in the future',
            );
          }
        }

        // 3. Build nested connect object for media relation (only when present)
        const mediaRelation =
          mediaFileIds.length > 0
            ? { connect: mediaFileIds.map((id) => ({ id })) }
            : undefined;

        // 4. Create post as DRAFT
        const post = await tx.post.create({
          data: {
            ...(dto.organizationId
              ? { organizationId: dto.organizationId }
              : {}),
            authorId: userId,
            socialAccountId: dto.socialAccountId,
            pageAccountId: dto.pageAccountId ?? null,
            content: dto.content,
            ...(mediaRelation ? { mediaFileIds: mediaRelation } : {}),
            status: PostStatus.DRAFT,
            timezone: timezone,
            contentType: dto.contentType,
            scheduledAt: finalScheduledAt,
            platform: dto.platform,
            metadata: {
              ...(dto.metadata || {}),
              postType: isProfilePost ? 'PROFILE' : 'PAGE',
            } as Prisma.JsonValue,
          },
          include: this.getPostIncludes(),
        });

        this.logger.log(`💾 Post ${post.id} created as draft`);

        return post;
      });
    } catch (err) {
      console.log(err);
      throw err;
    }
  }
  /**
   * Submit a draft post for approval workflow
   */
  async submitForApproval(postId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Validate post
      const post = await tx.post.findFirst({
        where: {
          id: postId,
          status: PostStatus.DRAFT,
        },
      });

      if (!post) {
        throw new NotFoundException(
          'Draft post not found or already submitted',
        );
      }

      // 2. Create approval request record
      await this.approvalsService.createApprovalRequest(postId, userId);

      // 3. Update post status to PENDING_APPROVAL
      const updatedPost = await tx.post.update({
        where: { id: postId },
        data: { status: PostStatus.PENDING_APPROVAL },
      });

      // 4. Optionally notify approvers
      // await this.notificationsService.notifyApprovers(organizationId, postId);

      this.logger.log(`📋 Draft post ${postId} submitted for approval`);

      return updatedPost;
    });
  }

  /**
   * Get organization posts with filters and pagination
   */
  async getOrganizationPosts(organizationId: string, filters: PostFilterDto) {
    const where = this.buildPostWhereClause(organizationId, filters);

    const [posts, total] = await Promise.all([
      this.prisma.post.findMany({
        where,
        include: this.getPostIncludes(),
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      this.prisma.post.count({ where }),
    ]);

    return {
      posts,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        pages: Math.ceil(total / filters.limit),
      },
    };
  }

  /**
   * Delete a post (only drafts and failed posts)
   */
  async deletePost(postId: string): Promise<void> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId },
      select: { status: true, jobId: true },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    if (
      !(
        [
          PostStatus.DRAFT,
          PostStatus.FAILED,
          PostStatus.CANCELED,
        ] as readonly PostStatus[]
      ).includes(post.status)
    ) {
      throw new BadRequestException(
        `Cannot delete post with status ${post.status}`,
      );
    }

    // Note: Job cancellation would now be handled by ApprovalsService
    // if it scheduled the post

    await this.prisma.post.delete({ where: { id: postId } });
    this.logger.log(`🗑️ Deleted post ${postId}`);
  }

  /** Get a single post by ID with details */
  async getPostById(postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId },
      include: this.getPostIncludes(),
    });

    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  /**
   * Update a post (only drafts or failed posts)
   */
  async updatePost(postId: string, dto: UpdatePostDto) {
    // fetch post and include media relation so TS knows about it
    const post = await this.prisma.post.findFirst({
      where: { id: postId },
      include: {
        mediaFileIds: { select: { id: true } },
      },
    });

    if (!post) throw new NotFoundException('Post not found');

    const EDITABLE_STATUSES: PostStatus[] = [
      PostStatus.DRAFT,
      PostStatus.FAILED,
      PostStatus.PENDING_APPROVAL,
    ];

    if (!EDITABLE_STATUSES.includes(post.status)) {
      throw new BadRequestException(
        `Cannot update post with status ${post.status}`,
      );
    }

    // scheduledAt validation
    if (dto.scheduledAt) {
      const scheduled = new Date(dto.scheduledAt);
      if (isNaN(scheduled.getTime())) {
        throw new BadRequestException('Invalid scheduledAt date');
      }
      if (scheduled <= new Date()) {
        throw new BadRequestException('Scheduled time must be in the future');
      }
    }

    // validate media files if provided
    if (dto.mediaFileIds?.length) {
      await this.validateMediaFiles(dto.mediaFileIds);
    }

    // build update payload
    const updateData: Prisma.PostUpdateInput = {
      content: dto.content ?? undefined,
      scheduledAt: dto.scheduledAt ?? undefined,
      updatedAt: new Date(),
    };

    if (dto.mediaFileIds) {
      updateData.mediaFileIds = {
        set: dto.mediaFileIds.map((id) => ({ id })),
      };
    }

    // perform update and return requested includes
    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: updateData,
      include: this.getPostIncludes(),
    });

    this.logger.log(`📝 Post ${postId} updated successfully`);
    return updated;
  }

  // ========== ORCHESTRATION METHODS ==========

  /**
   * Validate post creation inputs
   */
  private async validatePostCreation(
    userId: string,
    dto: CreatePostDto,
  ): Promise<void> {
    // Verify social account
    const socialAccount = await this.prisma.socialAccount.findFirst({
      where: {
        id: dto.socialAccountId,
        isActive: true,
      },
      include: {
        pages: true,
      },
    });

    if (!socialAccount) {
      throw new ForbiddenException('Social account not found or inactive');
    }

    const platformMismatch =
      socialAccount.platform === 'META'
        ? !['FACEBOOK', 'INSTAGRAM'].includes(dto.platform)
        : dto.platform !== socialAccount.platform;

    if (platformMismatch) {
      throw new BadRequestException(
        `Platform mismatch: expected ${socialAccount.platform}, got ${dto.platform}`,
      );
    }

    // NEW: Page account validation
    let pageAccount = null;

    if (dto.pageAccountId) {
      // This is a PAGE post - validate the page account
      pageAccount = socialAccount.pages.find(
        (page) => page.id === dto.pageAccountId,
      );

      if (!pageAccount) {
        throw new BadRequestException(
          'Page not found or not associated with this social account',
        );
      }
    }

    // Validate media files
    if (dto.mediaFileIds?.length > 0) {
      await this.validateMediaFiles(dto.mediaFileIds);
    }
  }

  private calculateUtcTime(
    localDateTimeString: string,
    timezone: string,
  ): Date {
    // This helper converts "9:00 AM in Lagos" to the equivalent Javascript Date object (which is always UTC internally)
    const utcDate = fromZonedTime(localDateTimeString, timezone);

    return utcDate;
  }

  /**
   * Validate media files belong to organization
   */
  private async validateMediaFiles(mediaFileIds: string[]): Promise<void> {
    const count = await this.prisma.mediaFile.count({
      where: {
        id: { in: mediaFileIds },
      },
    });

    if (count !== mediaFileIds.length) {
      throw new ForbiddenException(
        'One or more media files do not exist or belong to another organization',
      );
    }
  }

  /**
   * Build WHERE clause for post filtering
   */
  private buildPostWhereClause(
    organizationId: string,
    filters: PostFilterDto,
  ): Prisma.PostWhereInput {
    const where: Prisma.PostWhereInput = { organizationId };

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.platform) {
      where.socialAccount = { platform: filters.platform };
    }

    if (filters.startDate || filters.endDate) {
      where.scheduledAt = {};
      if (filters.startDate) {
        where.scheduledAt.gte = filters.startDate.toISOString();
      }
      if (filters.endDate) {
        where.scheduledAt.lte = filters.endDate.toISOString();
      }
    }

    if (filters.authorId) {
      where.authorId = filters.authorId;
    }

    return where;
  }
  /**
   * Standard post includes for queries
   */
  private getPostIncludes() {
    return {
      mediaFileIds: true,
      socialAccount: {
        select: {
          id: true,
          platform: true,
          username: true,
          isActive: true,
        },
      },
      author: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatar: true,
        },
      },
      approvals: {
        include: {
          approver: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      },
    };
  }
}
