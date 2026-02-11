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
import { isBefore, subMinutes } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import { BulkCreatePostDto } from '../dto/request/bulk-schedule.dto';
import { QueueSlotService } from '@/queue/queue.service';

@Injectable()
export class PostService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('media-ingest') private mediaIngestQueue: Queue,
    @InjectQueue('publishing-queue') private publishingQueue: Queue,
    private postFactory: PostFactory,
    private destinationBuilder: DestinationBuilder,
    private queueService: QueueSlotService,
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
        await tx.aiGeneration.update({
          where: { id: dto.aiGenerationId },
          data: { postId: post.id },
        });
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
    // 1) Precompute schedules + payloads (fail fast)
    const preparedPosts: Array<{
      dto: any;
      payloads: any[];
      status: 'PENDING_APPROVAL' | 'SCHEDULED' | 'DRAFT';
      finalScheduledAt: Date | null;
    }> = [];

    // If using auto-schedule, fetch N slots at once
    const autoScheduleCount = dto.posts.filter((p) => p.isAutoSchedule).length;

    let availableSlots: Date[] = [];
    if (autoScheduleCount > 0) {
      availableSlots = await this.queueService.getNextAvailableSlots(
        workspaceId,
        autoScheduleCount,
      );

      // If queue can't provide enough slots, fail (don’t silently schedule "now")
      if (availableSlots.length < autoScheduleCount) {
        throw new BadRequestException(
          `Queue is full: requested ${autoScheduleCount} auto-slots but only got ${availableSlots.length}.`,
        );
      }
    }

    let slotIndex = 0;

    for (const postDto of dto.posts) {
      let finalScheduledAt: Date | null = null;

      if (postDto.isAutoSchedule) {
        finalScheduledAt = availableSlots[slotIndex++];
      } else if (postDto.scheduledAt) {
        finalScheduledAt =
          postDto.timezone && !postDto.scheduledAt.endsWith('Z')
            ? fromZonedTime(postDto.scheduledAt, postDto.timezone)
            : new Date(postDto.scheduledAt);

        if (finalScheduledAt.getTime() < Date.now() - 5 * 60 * 1000) {
          throw new BadRequestException(
            `Post scheduled time is in the past: ${postDto.scheduledAt}`,
          );
        }
      }

      // Status logic must match single createPost:
      const status = postDto.needsApproval
        ? 'PENDING_APPROVAL'
        : finalScheduledAt
          ? 'SCHEDULED'
          : 'DRAFT';

      const payloads = await this.destinationBuilder.preparePayloads(
        workspaceId,
        postDto,
      );

      preparedPosts.push({
        dto: {
          ...postDto,
          scheduledAt: finalScheduledAt?.toISOString(),
        },
        payloads,
        status,
        finalScheduledAt,
      });
    }

    // 2) Create posts in ONE transaction
    // Return ALL created posts (including threads), because those also need jobs.
    const createdPosts = await this.prisma.$transaction(async (tx) => {
      const created: any[] = [];

      for (const item of preparedPosts) {
        const { dto: currentDto, payloads, status } = item;

        // A) Create master post with correct status
        const post = await this.postFactory.createMasterPost(
          tx,
          user.userId,
          workspaceId,
          currentDto,
          status,
        );

        // B) Save destinations for master
        await this.destinationBuilder.saveDestinations(tx, post.id, payloads);

        // C) Create approval record if needed
        if (currentDto.needsApproval) {
          await tx.postApproval.create({
            data: { postId: post.id, requesterId: user.id, status: 'PENDING' },
          });
        }

        created.push(post);

        // D) Handle threads (only for X/Twitter payloads)
        const twitterPayloads = payloads.filter(
          (p) => p.platform === 'TWITTER',
        );

        // Threads should inherit master status + scheduledAt/timezone/campaignId
        if (twitterPayloads.length > 0 && currentDto.threads?.length > 0) {
          let previousPostId = post.id;

          for (const threadItem of currentDto.threads) {
            const threadPost = await this.postFactory.createThreadPost(
              tx,
              user.userId,
              workspaceId,
              previousPostId,
              threadItem,
              status, // ✅ use same status as master
              post.scheduledAt, // ✅ same scheduled time as master (or null)
              post.timezone,
              currentDto.campaignId,
            );

            await this.destinationBuilder.saveDestinations(
              tx,
              threadPost.id,
              twitterPayloads,
            );

            created.push(threadPost);
            previousPostId = threadPost.id;
          }
        }
      }

      return created;
    });

    // 3) Enqueue AFTER transaction commit
    const jobs = createdPosts
      .filter(
        (p) =>
          p.status === 'SCHEDULED' && p.scheduledAt && p.parentPostId === null,
      )
      .map((p) => ({
        name: 'publish-post',
        data: { postId: p.id },
        opts: {
          delay: Math.max(0, new Date(p.scheduledAt).getTime() - Date.now()),
          jobId: p.id,
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      }));

    if (jobs.length > 0) {
      await this.publishingQueue.addBulk(jobs);
    }

    // Return only master posts or everything — your choice.
    // Usually return masters; UI can fetch threads via GET /posts/:id?includeThreads=true
    const masterPosts = createdPosts.filter((p) => p.parentPostId == null);
    return masterPosts;
  }

async updatePost(workspaceId: string, postId: string, dto: UpdatePostDto) {
  const existing = await this.prisma.post.findFirst({
    where: { id: postId, workspaceId },
    select: { id: true, status: true, scheduledAt: true, parentPostId: true },
  });

  if (!existing) throw new NotFoundException('Post not found');
  if (['PUBLISHING', 'PUBLISHED'].includes(existing.status)) {
    throw new BadRequestException('Cannot edit a post in progress.');
  }

  // Determine the new schedule
  let finalScheduledAt = dto.scheduledAt
    ? new Date(dto.scheduledAt)
    : existing.scheduledAt;

  if (dto.isAutoSchedule) {
    const slots = await this.queueService.getNextAvailableSlots(workspaceId, 1);
    if (!slots.length) throw new BadRequestException('No available queue slots.');
    finalScheduledAt = slots[0];
  }

  // Prevent bypass: if pending approval, never move to SCHEDULED here
  const isPendingApproval = existing.status === 'PENDING_APPROVAL';

  const updated = await this.prisma.$transaction(async (tx) => {
    const post = await tx.post.update({
      where: { id: postId },
      data: {
        content: dto.content ?? undefined,
        scheduledAt: finalScheduledAt,

        // status logic
        status: isPendingApproval
          ? 'PENDING_APPROVAL'
          : (dto.scheduledAt || dto.isAutoSchedule)
            ? 'SCHEDULED'
            : undefined,
      } as any,
    });

    // Media updates...
    if (dto.mediaIds) {
      await tx.postMedia.deleteMany({ where: { postId } as any });
      await tx.postMedia.createMany({
        data: dto.mediaIds.map((mid, idx) => ({
          postId,
          mediaFileId: mid,
          order: idx,
        })),
      });
    }

    // Sync children schedule
    if (finalScheduledAt && existing.parentPostId === null) {
      await tx.post.updateMany({
        where: { parentPostId: postId } as any,
        data: { scheduledAt: finalScheduledAt } as any,
      });
    }

    return post;
  });

  // ✅ Queue sync only if not pending approval
  if (updated.status === 'SCHEDULED' && updated.scheduledAt) {
    await this.schedulePostJob(updated.id, updated.scheduledAt);
  } else {
    await this.removePostJob(updated.id);
  }

  return updated;
}


async deletePost(workspaceId: string, postId: string) {
  const post = await this.prisma.post.findFirst({
    where: { id: postId, workspaceId },
    select: { id: true, parentPostId: true },
  });
  if (!post) throw new NotFoundException('Post not found');

  const rootId = post.parentPostId ? post.parentPostId : post.id;

  await this.removePostJob(rootId);

  const deleteIds = await this.collectDescendantPostIds(workspaceId, rootId);

  return this.prisma.post.deleteMany({
    where: { workspaceId, id: { in: deleteIds } } as any,
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
            metadata: true,
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
      destinations: post.destinations.map((dest: any) => ({
        ...dest,
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
    // 1. Fetch & Validate
    const approval = await this.prisma.postApproval.findFirst({
      where: { id: approvalId, post: { workspaceId } },
      include: { post: true },
    });

    if (!approval) throw new NotFoundException('Approval request not found');
    if (approval.status !== 'PENDING')
      throw new BadRequestException('Already reviewed');

    const post = approval.post;
    let finalScheduledAt = post.scheduledAt;

    // 2. Logic for Approval: Handle Stale Time
    if (status === 'APPROVED') {
      const isPast =
        finalScheduledAt && finalScheduledAt.getTime() < Date.now();
      const isMissing = !finalScheduledAt; // Case where post was created as auto-schedule but date wasn't set yet

      if (isPast || isMissing) {
        // Call the internal queue engine to find the next valid spot
        const slots = await this.queueService.getNextAvailableSlots(
          workspaceId,
          1,
        );

        if (slots.length > 0) {
          finalScheduledAt = slots[0];
        } else if (isMissing) {
          // If it's missing a date and no slots exist, we have a problem
          throw new BadRequestException(
            'No available queue slots to schedule this post.',
          );
        } else {
          // If it was just stale but no slots found, fallback to 'Now'
          finalScheduledAt = new Date();
        }
      }
    }
    // 3. Database Transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Update Approval Record
      await tx.postApproval.update({
        where: { id: approvalId },
        data: {
          status,
          approverId: approver.id,
          reviewedAt: new Date(),
          notes,
        },
      });

      // Update Post
      return await tx.post.update({
        where: { id: post.id },
        data: {
          status: status === 'APPROVED' ? 'SCHEDULED' : 'DRAFT',
          scheduledAt:
            status === 'APPROVED' ? finalScheduledAt : post.scheduledAt,
        },
      });
    });

    // 4. Queue Sync (Outside Transaction)
    if (result.status === 'SCHEDULED' && result.scheduledAt) {
      await this.schedulePostJob(result.id, result.scheduledAt);
    } else {
      await this.removePostJob(result.id);
    }

    return result;
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
      const slots = await this.queueService.getNextAvailableSlots(
        workspaceId,
        1,
      );

      if (!slots || slots.length === 0) {
        throw new BadRequestException('No available queue slots found.');
      }
      finalScheduledAt = slots[0];
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

  private async collectDescendantPostIds(
  workspaceId: string,
  rootId: string,
): Promise<string[]> {
  const ids: string[] = [];
  let frontier: string[] = [rootId];

  while (frontier.length) {
    // grab children of everything in the current frontier
    const children = await this.prisma.post.findMany({
      where: {
        workspaceId,
        parentPostId: { in: frontier },
      } as any,
      select: { id: true },
    });

    const childIds = children.map((c) => c.id);
    ids.push(...childIds);

    frontier = childIds;
  }

  return [rootId, ...ids];
}

}
