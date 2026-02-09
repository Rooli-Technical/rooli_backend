import { PrismaService } from '@/prisma/prisma.service';
import { PostStatus, Prisma, User } from '@generated/client';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreatePostDto } from '../dto/request/create-post.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { UpdatePostDto } from '../dto/request/update-post.dto';
import { GetWorkspacePostsDto } from '../dto/request/get-all-posts.dto';
import { QueryMode } from '@generated/internal/prismaNamespace';
import { DestinationBuilder } from './destination-builder.service';
import { PostFactory } from './post-factory.service';
import { QueueService } from '@/queue/queue.service';
import { isBefore, subMinutes } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import { BulkCreatePostDto } from '../dto/request/bulk-schedule.dto';

@Injectable()
export class PostService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('media-ingest') private mediaIngestQueue: Queue,
    @InjectQueue('publishing-queue') private publishingQueue: Queue,
    private postFactory: PostFactory,
    private destinationBuilder: DestinationBuilder,
    private queueService: QueueService,
  ) {}

  async createPost(user: any, workspaceId: string, dto: CreatePostDto) {
    this.validateFeatures(user, dto);

    const { finalScheduledAt, status } = await this.resolveScheduleAndStatus(
      workspaceId,
      dto,
    );

    const payloads = await this.destinationBuilder.preparePayloads(
      workspaceId,
      dto,
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const post = await this.postFactory.createMasterPost(
        tx,
        user.userId,
        workspaceId,
        { ...dto, scheduledAt: finalScheduledAt?.toISOString() },
        status,
      );

      await this.destinationBuilder.saveDestinations(tx, post.id, payloads);

      if (dto.needsApproval) {
        await this.createApproval(tx, post.id, user.id);
      }

      if (dto.aiGenerationId) {
        this.prisma.aiGeneration
          .update({
            where: { id: dto.aiGenerationId },
            data: { postId: post.id },
          })
          .catch((err) => console.error('Failed to link post to AI log', err));
      }

      return post;
    });

    // ✅ enqueue AFTER transaction commit
    if (status === 'SCHEDULED' && finalScheduledAt) {
      const delay = Math.max(0, finalScheduledAt.getTime() - Date.now());

      await this.publishingQueue.add(
        'publish-post',
        { postId: created.id },
        {
          delay,
          jobId: created.id, // idempotency: one job per post
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    }

    return created;
  }

  /**
   * Helper to check Pricing Limits
   */
  private validateFeatures(user: User, dto: CreatePostDto) {
    // We navigate safely in case 'features' is not flattened
    const features =
      user['features'] ||
      user['organization']?.subscription?.plan?.features ||
      {};

    // Check Approval Access
    if (dto.needsApproval && !features.approvalWorkflow) {
      throw new ForbiddenException(
        'Upgrade to Business Plan to use Approval Workflows',
      );
    }

    // Check Campaign Access
    if (dto.campaignId && !features.hasCampaigns) {
      throw new ForbiddenException('Upgrade to Rocket Plan to use Campaigns');
    }
  }

  async getWorkspacePosts(workspaceId: string, dto: GetWorkspacePostsDto) {
    const { page, limit, status, contentType, search } = dto;

    const where = {
      workspaceId,
      ...(status && { status }),
      ...(contentType && { contentType }),
      ...(search && {
        content: { contains: search, mode: QueryMode.insensitive },
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({
        where,
        select: {
          id: true,
          workspaceId: true,
          authorId: true,
          content: true,
          contentType: true,
          status: true,
          scheduledAt: true,
          publishedAt: true,

          destinations: {
            select: {
              id: true,
              postId: true,
              contentOverride: true,
              profile: {
                select: {
                  platform: true,
                  name: true,
                  username: true,
                  picture: true,
                  type: true,
                },
              },
            },
          },
          media: {
            orderBy: { order: 'asc' },
            select: {
              id: true,
              order: true,
              mediaFile: {
                select: {
                  id: true,
                  url: true,
                  mimeType: true,
                  size: true,
                },
              },
            },
          },

          author: {
            select: {
              email: true,
              firstName: true,
            },
          },

          campaign: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.post.count({ where }),
    ]);

    const sanitizedItems = items.map((post) => ({
      ...post,
      media: post.media.map((m) => ({
        ...m,
        mediaFile: m.mediaFile
          ? {
              ...m.mediaFile,
              size: m.mediaFile.size.toString(),
            }
          : null,
      })),
    }));

    return {
      data: sanitizedItems,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
  async bulkSchedulePosts(
    user: any,
    workspaceId: string,
    dto: BulkCreatePostDto,
  ) {
    // We prepare the payloads for ALL posts first to fail fast if validation errors exist.
    const preparedPosts = [];

    for (const postDto of dto.posts) {
      // A. Basic Date Validation
      if (postDto.scheduledAt) {
        const scheduledDate = new Date(postDto.scheduledAt);
        if (scheduledDate < new Date()) {
          throw new BadRequestException(
            `Post scheduled for ${postDto.scheduledAt} is in the past.`,
          );
        }
      }

      // B. Prepare Destination Payloads
      // This handles the "Twitter Thread vs LinkedIn Post" logic automatically
      const payloads = await this.destinationBuilder.preparePayloads(
        workspaceId,
        postDto,
      );

      preparedPosts.push({ dto: postDto, payloads });
    }

    // 3. The Transaction
    // If one post fails, we roll back everything so the user can fix and retry.
    return this.prisma.$transaction(async (tx) => {
      const results = [];

      for (const item of preparedPosts) {
        const { dto: currentDto, payloads } = item;

        // A. Create Master Post
        const post = await this.postFactory.createMasterPost(
          tx,
          user.userId,
          workspaceId,
          currentDto,
          'SCHEDULED', // Bulk posts are usually implicitly approved/scheduled
        );

        // B. Save Destinations (Master)
        await this.destinationBuilder.saveDestinations(tx, post.id, payloads);

        // C. Handle Threads
        // ----------------------------------------------------
        const twitterPayloads = payloads.filter(
          (p) => p.platform === 'TWITTER',
        );

        if (twitterPayloads.length > 0 && currentDto.threads?.length > 0) {
          let previousPostId = post.id;

          for (const threadItem of currentDto.threads) {
            const threadPost = await this.postFactory.createThreadPost(
              tx,
              user.userId,
              workspaceId,
              previousPostId,
              threadItem,
              'SCHEDULED',
              post.scheduledAt,
              post.timezone,
              currentDto.campaignId,
            );

            await this.destinationBuilder.saveDestinations(
              tx,
              threadPost.id,
              twitterPayloads,
            );
            previousPostId = threadPost.id;
          }
        }

        results.push(post);
      }

      return results;
    });
  }

  async updatePost(workspaceId: string, postId: string, dto: UpdatePostDto) {
    const existing = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId },
      include: { media: true },
    });

    if (!existing) throw new NotFoundException('Post not found');

    if (existing.status === 'PUBLISHING' || existing.status === 'PUBLISHED') {
      throw new BadRequestException(
        'Cannot edit a post that is published or processing.',
      );
    }

    const oldScheduledAt = existing.scheduledAt?.getTime() ?? null;
    const newScheduledAt = dto.scheduledAt
      ? new Date(dto.scheduledAt).getTime()
      : null;

    const isRoot = existing.parentPostId === null;

    // Run DB transaction
    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedPost = await tx.post.update({
        where: { id: postId },
        data: {
          content: dto.content ?? undefined,
          scheduledAt: dto.scheduledAt ?? undefined,

          // If it was FAILED and user edits, move it back to SCHEDULED/DRAFT intentionally
          status:
            existing.status === 'FAILED'
              ? dto.scheduledAt
                ? 'SCHEDULED'
                : 'DRAFT'
              : undefined,
        },
      });

      if (dto.mediaIds) {
        await tx.postMedia.deleteMany({ where: { postId } });
        await tx.postMedia.createMany({
          data: dto.mediaIds.map((mid, idx) => ({
            postId,
            mediaFileId: mid,
            order: idx,
          })),
        });
      }

      // If you move root time, move children times too
      if (dto.scheduledAt && isRoot) {
        await tx.post.updateMany({
          where: { parentPostId: postId },
          data: { scheduledAt: dto.scheduledAt },
        });
      }

      return updatedPost;
    });

    // ===== Queue sync AFTER commit =====

    // Decide if this post should have a delayed job
    const shouldSchedule =
      isRoot && updated.status === 'SCHEDULED' && !!updated.scheduledAt;

    const scheduleChanged = oldScheduledAt !== newScheduledAt;

    // Also refresh job if status moved into/out of SCHEDULED
    const statusChangedAffectsJob =
      (existing.status === 'SCHEDULED') !== (updated.status === 'SCHEDULED');

    const needsJobRefresh = scheduleChanged || statusChangedAffectsJob;

    if (needsJobRefresh) {
      // Always remove old job
      await this.removePostJob(postId);

      // Re-add if still schedulable
      if (shouldSchedule) {
        await this.schedulePostJob(postId, updated.scheduledAt!);
      }
    } else {
      // Schedule not changed, but ensure job exists if it should
      if (shouldSchedule) {
        const job = await this.publishingQueue.getJob(postId);
        if (!job) await this.schedulePostJob(postId, updated.scheduledAt!);
      } else {
        // If it shouldn't be scheduled, make sure there is no job hanging around
        await this.removePostJob(postId);
      }
    }

    return updated;
  }

  async deletePost(workspaceId: string, postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId },
      select: { id: true, parentPostId: true },
    });

    if (!post) throw new NotFoundException('Post not found');

    // Only root posts have scheduled jobs in your design
    const rootId = post.parentPostId ? post.parentPostId : post.id;

    // remove queue job (idempotent)
    await this.removePostJob(rootId);

    // delete chain
    const deleteIds = [rootId];
    const children = await this.prisma.post.findMany({
      where: { parentPostId: rootId },
      select: { id: true },
    });
    deleteIds.push(...children.map((c) => c.id));

    return this.prisma.post.deleteMany({
      where: { id: { in: deleteIds }, workspaceId },
    });
  }

  async getOne(workspaceId: string, postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId },
      select: {
        id: true,
        workspaceId: true,
        authorId: true,
        content: true,
        contentType: true,
        status: true,
        scheduledAt: true,
        publishedAt: true,
        destinations: {
          select: {
            id: true,
            postId: true,
            contentOverride: true,
            metadata: true, // IMPORTANT: This contains your thread
            profile: {
              select: {
                id: true,
                platform: true,
                name: true,
                username: true,
                picture: true,
                type: true,
              },
            },
          },
        },
        media: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            order: true,
            mediaFile: {
              select: {
                id: true,
                url: true,
                mimeType: true,
                size: true,
              },
            },
          },
        },
        author: {
          select: {
            email: true,
            firstName: true,
          },
        },
        parentPost: true,
      },
    });

    if (!post) throw new NotFoundException('Post not found');

    // Map the data to handle BigInt (size) and expose threads clearly
    return {
      ...post,
      media: post.media.map((m) => ({
        ...m,
        mediaFile: m.mediaFile
          ? {
              ...m.mediaFile,
              size: m.mediaFile.size.toString(),
            }
          : null,
      })),
      // Helper: Extract threads from destinations to make them easier to find
      destinations: post.destinations.map((dest: any) => ({
        ...dest,
        // Explicitly extract the thread from metadata for the frontend
        thread: dest.metadata?.thread || [],
      })),
    };
  }

  // Get all pending approvals for a workspace
  async getPendingApprovals(
    workspaceId: string,
    pagination: { page: number; limit: number },
  ) {
    const { page, limit } = pagination;

    const where = {
      post: { workspaceId },
      status: 'PENDING' as const,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.postApproval.findMany({
        where,
        include: {
          post: {
            select: {
              content: true,
              scheduledAt: true,
              contentType: true,
            },
          },
          requester: {
            select: {
              id: true,
              firstName: true,
              email: true,
            },
          },
        },
        orderBy: { requestedAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.postApproval.count({ where }),
    ]);

    return {
      data: items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // Approve or Reject (The Decision)
  async reviewApproval(
    approver: User,
    workspaceId: string,
    approvalId: string,
    status: 'APPROVED' | 'REJECTED',
    notes?: string,
  ) {
    // Fetch Approval & Verify Workspace
    const approval = await this.prisma.postApproval.findFirst({
      where: { id: approvalId, post: { workspaceId } },
      include: { post: true },
    });

    if (!approval) throw new NotFoundException('Approval request not found');
    if (approval.status !== 'PENDING')
      throw new BadRequestException('Already reviewed');

    return this.prisma.$transaction(async (tx) => {
      //Update Approval Record
      const updatedApproval = await tx.postApproval.update({
        where: { id: approvalId },
        data: {
          status,
          approverId: approver.id,
          reviewedAt: new Date(),
          notes: notes,
        },
      });

      // Update Post Status
      // If Approved -> SCHEDULED
      // If Rejected -> DRAFT (so they can edit and try again)
      await tx.post.update({
        where: { id: approval.postId },
        data: {
          status: status === 'APPROVED' ? 'SCHEDULED' : 'DRAFT',
        },
      });

      return updatedApproval;
    });
  }

  //  DELETE: Cancel a Request
  async cancelApprovalRequest(
    userId: string,
    workspaceId: string,
    approvalId: string,
  ) {
    const approval = await this.prisma.postApproval.findFirst({
      where: { id: approvalId, post: { workspaceId } },
    });

    if (!approval) throw new NotFoundException('Request not found');

    // Security: Only the requester (or an Admin) should be able to cancel
    if (approval.requesterId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to cancel this request.',
      );
      // In a real app, check if user is Admin, otherwise throw Forbidden
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Delete the Approval Row
      await tx.postApproval.delete({ where: { id: approvalId } });

      // 2. Set Post back to DRAFT
      await tx.post.update({
        where: { id: approval.postId },
        data: { status: 'DRAFT' },
      });
    });
  }

  private async resolveScheduleAndStatus(
    workspaceId: string,
    dto: CreatePostDto,
  ) {
    let finalScheduledAt: Date | null = null;

    if (dto.isAutoSchedule) {
      finalScheduledAt =
        await this.queueService.getNextAvailableSlot(workspaceId);
    } else if (dto.scheduledAt) {
      finalScheduledAt =
        dto.timezone && !dto.scheduledAt.endsWith('Z')
          ? fromZonedTime(dto.scheduledAt, dto.timezone)
          : new Date(dto.scheduledAt);

      // Past date check
      if (isBefore(finalScheduledAt, subMinutes(new Date(), 5))) {
        throw new BadRequestException('Scheduled time is in the past.');
      }
    }

    const status: PostStatus = dto.needsApproval
      ? 'PENDING_APPROVAL'
      : finalScheduledAt
        ? 'SCHEDULED'
        : 'DRAFT';

    return { finalScheduledAt, status };
  }

  private async createApproval(
    tx: Prisma.TransactionClient,
    postId: string,
    userId: string,
  ) {
    await tx.postApproval.create({
      data: { postId, requesterId: userId, status: 'PENDING' },
    });
  }
  
  private async schedulePostJob(postId: string, scheduledAt: Date) {
    const delay = Math.max(0, scheduledAt.getTime() - Date.now());

    await this.publishingQueue.add(
      'publish-post',
      { postId },
      {
        delay,
        jobId: postId, // one job per post
        removeOnComplete: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  }

  private async removePostJob(postId: string) {
    const job = await this.publishingQueue.getJob(postId);
    if (job) await job.remove();
  }
}
