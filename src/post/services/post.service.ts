import { PrismaService } from '@/prisma/prisma.service';
import { PlanTier, PostStatus, Prisma, User } from '@generated/client';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
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
import { SocialFactory } from '@/social/social.factory';
import { EncryptionService } from '@/common/utility/encryption.service';
import { DomainEventsService } from '@/events/domain-events.service';
import { PlanAccessService } from '@/plan-access/plan-access.service';
import { RequiresUpgradeException } from '@/common/exceptions/requires-upgrade.exception';


@Injectable()
export class PostService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('media-ingest') private mediaIngestQueue: Queue,
    @InjectQueue('publishing-queue') private publishingQueue: Queue,
    private postFactory: PostFactory,
    private destinationBuilder: DestinationBuilder,
    private queueService: QueueSlotService,
    private socialFactory: SocialFactory,
    private encryptionService: EncryptionService,
    private readonly domainEvents: DomainEventsService,
    private readonly planAccessService: PlanAccessService,
  ) {}

  async createPost(user: any, workspaceId: string, dto: CreatePostDto) {
    await this.validateFeatures(user, dto, workspaceId);

    // 🚨 Apply Watermark (Passing the single DTO in an array)
    await this.applyTrialWatermark(workspaceId, [dto]);

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

    if (dto.needsApproval) {
      this.domainEvents.emit('publishing.post.requires_approval', {
        workspaceId,
        postId: created.id,
        authorName: user.firstName ? `${user.firstName} ${user.lastName}`.trim() : 'A team member',
        snippet: dto.content ? dto.content.substring(0, 60) : 'a new post',
      });
    }

    return created;
  }

  async saveDraft(user: any, workspaceId: string, dto: UpdatePostDto) {
    // 1. Force the status to DRAFT and clear any accidental schedules
    const status = 'DRAFT';
    const draftDto = {
      ...dto,
      scheduledAt: null,
      isAutoSchedule: false,
      needsApproval: false, 
    };

    // 2. Prepare payloads if they checked any social profiles
    // (This ensures the draft remembers which accounts they had selected)
    let payloads = [];
    if (dto.socialProfileIds && dto.socialProfileIds.length > 0) {
      payloads = await this.destinationBuilder.preparePayloads(
        workspaceId,
        draftDto,
      );
    }

    // 3. Save to database in a clean transaction
    const draft = await this.prisma.$transaction(async (tx) => {
      const post = await this.postFactory.createMasterPost(
        tx,
        user.userId,
        workspaceId,
        draftDto,
        status,
      );

      if (payloads.length > 0) {
        await this.destinationBuilder.saveDestinations(tx, post.id, payloads);
      }

      // Link to AI history if this draft came from the AI generator
      if (dto.aiGenerationId) {
        await tx.aiGeneration.update({
          where: { id: dto.aiGenerationId },
          data: { postId: post.id },
        });
      }

      return post;
    });

    return draft;
  }

  /**
   * Helper to check Pricing Limits
   */
private async validateFeatures(
    user: any,
    dto: CreatePostDto | BulkCreatePostDto | UpdatePostDto,
    workspaceId: string,
  ) {
    // 1. Fetch Workspace, Plan Features, and User Role in ONE query
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        organization: {
          include: {
            subscription: { include: { plan: true } },
            // Grab the specific member record for the user making this request
            members: {
              where: { userId: user.id },
              include: { role: true }, 
            },
          },
        },
      },
    });

    if (!ws) throw new NotFoundException('Workspace not found');

    const plan = ws.organization?.subscription?.plan;
    const features = (plan?.features as any) || {};
    const tier = plan?.tier as PlanTier;
    
    // Fallback to 'contributor' if role isn't found
    const userRoleSlug = ws.organization?.members[0]?.role?.slug?.toLowerCase() || 'contributor';

    // ==========================================
    // RULE 2: APPROVAL ENFORCEMENT
    // ==========================================
    const premiumTiers = ['BUSINESS', 'ROCKET', 'ENTERPRISE'];
    const isPremium = premiumTiers.includes(tier);

    // Identify lower-level employees (Adjust these slugs based on your DB!)
    const isLowerLevelEmployee = ['contributor', 'editor'].includes(userRoleSlug);
    const mustHaveApproval = isPremium && isLowerLevelEmployee;

    // Helper function to process a single post object
    const enforceApprovalLogic = (postDto: any) => {
      // A. Force overrides based on hierarchy
      if (mustHaveApproval) {
        postDto.needsApproval = true; // Force employees into approval
      } else if (!isPremium || !features.approvalWorkflow) {
        postDto.needsApproval = false; // Strip it from Free/Creator plans
      }

      // B. Security check: If they somehow kept needsApproval=true but don't have the feature
      if (postDto.needsApproval && !features.approvalWorkflow) {
        throw new RequiresUpgradeException(
          'Approval Workflows',
          'Upgrade to Business Plan to use Approval Workflows');
      }
    };

    // Apply logic depending on whether it's Bulk or Single DTO
    if ('posts' in dto) {
      dto.posts.forEach((post) => enforceApprovalLogic(post));
    } else {
      enforceApprovalLogic(dto);
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
    await this.planAccessService.ensureFeatureAccess(workspaceId, 'bulkScheduling');
    await this.validateFeatures(user, dto, workspaceId);
    // 🚨 Apply Watermark (Passing the single DTO in an array)
    await this.applyTrialWatermark(workspaceId, [dto]);
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
      const { finalScheduledAt, status } = await this.resolvePostSchedule(
        workspaceId,
        postDto,
        postDto.isAutoSchedule ? availableSlots[slotIndex++] : undefined,
      );

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
              status,
              post.scheduledAt,
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

async updatePost(
    user: any, 
    workspaceId: string, 
    postId: string, 
    dto: UpdatePostDto
  ) {
    const existing = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId },
      select: { 
        id: true, 
        status: true, 
        scheduledAt: true, 
        parentPostId: true,
        content: true // Grab existing content in case they didn't send it in the DTO
      },
    });

    if (!existing) throw new NotFoundException('Post not found');
    if (['PUBLISHING', 'PUBLISHED'].includes(existing.status)) {
      throw new BadRequestException('Cannot edit a post in progress.');
    }

    // 🚨 PATCH THE LOOPHOLE: Run the exact same checks as createPost!
    await this.validateFeatures(user, dto, workspaceId);

    // If they are scheduling it, we must ensure the watermark is applied.
    // We merge the existing content if the DTO didn't include it.
    const dtoWithContent = {
      ...dto,
      content: dto.content ?? existing.content,
    };
    await this.applyTrialWatermark(workspaceId, [dtoWithContent]);

    const { finalScheduledAt, status } = await this.resolvePostSchedule(
      workspaceId,
      {
        ...dtoWithContent,
        needsApproval: existing.status === 'PENDING_APPROVAL' || dtoWithContent.needsApproval,
      },
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const post = await tx.post.update({
        where: { id: postId },
        data: {
          content: dtoWithContent.content, // Save the watermarked content
          scheduledAt: finalScheduledAt,
          status,
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

      // Sync children schedule for Twitter threads
      if (finalScheduledAt && existing.parentPostId === null) {
        await tx.post.updateMany({
          where: { parentPostId: postId } as any,
          data: { scheduledAt: finalScheduledAt } as any,
        });
      }

      return post;
    });

    // 1. ALWAYS kill the old job first. 
    // This clears the queue in case they changed the time from 2pm to 5pm!
    await this.removePostJob(updated.id);

    // 2. If it is still meant to be scheduled, add it back to the queue with the fresh time.
    if (updated.status === 'SCHEDULED' && updated.scheduledAt) {
      await this.schedulePostJob(updated.id, updated.scheduledAt);
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

  async editPublishedPost(
    workspaceId: string,
    postId: string,
    newContent: string,
  ) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId },
      include: {
        destinations: {
          include: { profile: { include: { connection: true } } },
        },
      },
    });

    if (!post) throw new NotFoundException('Post not found');
    if (!['PUBLISHED'].includes(post.status)) {
      throw new BadRequestException(
        'You can only edit posts that have already been published.',
      );
    }

    const results = { success: [] as string[], errors: [] as any[] };
    let dbUpdated = false;

    for (const dest of post.destinations) {
      if (!dest.platformPostId || dest.status !== 'SUCCESS') continue;

      // strictly block non-facebook platforms
      if (dest.profile.platform !== 'FACEBOOK') {
        results.errors.push({
          platform: dest.profile.platform,
          message: `Editing published posts is blocked by the ${dest.profile.platform} API.`,
        });
        continue;
      }

      try {
        const provider = this.socialFactory.getProvider('FACEBOOK') as any; // Cast to your FB provider
        const credentials = await this.resolveOAuth2Creds(dest);

        await provider.editContent(
          credentials.accessToken,
          dest.platformPostId,
          newContent,
        );

        // Update the destination's specific override content
        await this.prisma.postDestination.update({
          where: { id: dest.id },
          data: { contentOverride: newContent },
        });

        results.success.push(dest.profile.name);
        dbUpdated = true;
      } catch (error: any) {
        results.errors.push({ platform: 'FACEBOOK', message: error.message });
      }
    }

    // Update the master post content if at least one edit succeeded
    if (dbUpdated) {
      await this.prisma.post.update({
        where: { id: postId },
        data: { content: newContent },
      });
    }

    return { message: 'Edit operation complete', results };
  }

  async deletePublishedPost(workspaceId: string, postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId },
      include: {
        destinations: {
          include: { profile: { include: { connection: true } } },
        },
      },
    });

    if (!post) throw new NotFoundException('Post not found');
    if (!['PUBLISHED'].includes(post.status)) {
      throw new BadRequestException('Can only delete published posts.');
    }

    const results = { success: [] as string[], errors: [] as any[] };

    for (const dest of post.destinations) {
      if (!dest.platformPostId || dest.status !== 'SUCCESS') continue;

      if (dest.profile.platform !== 'FACEBOOK') {
        results.errors.push({
          platform: dest.profile.platform,
          message: `Deleting published posts is blocked by the ${dest.profile.platform} API.`,
        });
        continue;
      }

      try {
        const provider = this.socialFactory.getProvider('FACEBOOK') as any;
        const credentials = await this.resolveOAuth2Creds(dest);

        await provider.deleteContent(
          credentials.accessToken,
          dest.platformPostId,
        );

        // Mark destination as deleted in DB
        await this.prisma.postDestination.update({
          where: { id: dest.id },
          data: { status: 'FAILED', errorMessage: 'Deleted by user' }, // Or create a 'DELETED' status
        });

        results.success.push(dest.profile.name);
      } catch (error: any) {
        results.errors.push({ platform: 'FACEBOOK', message: error.message });
      }
    }

    return { message: 'Delete operation complete', results };
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

    // 1. Determine the Target Platform based on the provided Profile IDs
    let targetPlatform = null;
    
    if (dto.isAutoSchedule && dto.socialProfileIds?.length > 0) {
      // Fetch the unique platforms for the selected profiles
      const profiles = await this.prisma.socialProfile.findMany({
        where: { 
          id: { in: dto.socialProfileIds }, 
          workspaceId 
        },
        select: { platform: true },
        distinct: ['platform'], // Only returns unique platforms
      });

      // If every profile they selected belongs to the EXACT SAME platform, use it!
      // Otherwise, keep it null so it uses a "Universal" slot.
      if (profiles.length === 1) {
        targetPlatform = profiles[0].platform;
      }
    }

    // 2. Schedule Logic
    if (dto.isAutoSchedule) {
      const slots = await this.queueService.getNextAvailableSlots(
        workspaceId,
        1,
        targetPlatform
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

    // 3. Status Logic
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

  private async resolvePostSchedule(
    workspaceId: string,
    dto: {
      isAutoSchedule?: boolean;
      scheduledAt?: string | Date | null;
      timezone?: string | null;
      needsApproval?: boolean;
    },
    providedAutoSlot?: Date, // Used by bulk to pass in pre-fetched slots
  ) {
    let finalScheduledAt: Date | null = null;

    // 1. Determine the Date
    if (dto.isAutoSchedule) {
      if (providedAutoSlot) {
        finalScheduledAt = providedAutoSlot;
      } else {
        const slots = await this.queueService.getNextAvailableSlots(
          workspaceId,
          1,
        );
        if (!slots?.length)
          throw new BadRequestException('No available queue slots.');
        finalScheduledAt = slots[0];
      }
    } else if (dto.scheduledAt) {
      finalScheduledAt =
        typeof dto.scheduledAt === 'string'
          ? dto.timezone && !dto.scheduledAt.endsWith('Z')
            ? fromZonedTime(dto.scheduledAt, dto.timezone)
            : new Date(dto.scheduledAt)
          : dto.scheduledAt;

      if (isNaN(finalScheduledAt.getTime())) {
        throw new BadRequestException('Invalid scheduledAt datetime.');
      }

      // Centralized Past Date Check
      if (isBefore(finalScheduledAt, subMinutes(new Date(), 5))) {
        throw new BadRequestException('Scheduled time is in the past.');
      }
    }

    // 2. Determine the Status
    const status: PostStatus = dto.needsApproval
      ? 'PENDING_APPROVAL'
      : finalScheduledAt
        ? 'SCHEDULED'
        : 'DRAFT';

    return { finalScheduledAt, status };
  }

  async listPostsWithMetrics(params: {
    workspaceId: string;
    take: number;
    cursor?: string;
  }) {
    const { workspaceId, take, cursor } = params;

    const posts = await this.prisma.post.findMany({
      where: { workspaceId },
      take,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        destinations: {
          include: {
            profile: true,
            postAnalyticsSnapshots: {
              orderBy: { day: 'desc' },
              take: 1,
              // 1. INCLUDE THE SPECIFIC TABLES
              include: {
                twitterStats: true,
                linkedInStats: true,
                facebookStats: true,
                instagramStats: true,
                tiktokStats: true,
              },
            },
          },
        },
      },
    });

    const items = posts.map((post) => {
      let totalLikes = 0, totalComments = 0, totalImpressions = 0, totalReach = 0, totalShares = 0;
      
      // Aggregate across ALL destinations (Facebook + LinkedIn + Twitter, etc.)
      post.destinations.forEach((dest) => {
        const stats = dest.postAnalyticsSnapshots[0];
        if (!stats) return;

        totalLikes += stats.likes ?? 0;
        totalComments += stats.comments ?? 0;
        totalImpressions += stats.impressions ?? 0;
        totalReach += stats.reach ?? 0;

        const platform = dest.profile?.platform;
        if (platform === 'TWITTER') totalShares += (stats.twitterStats?.retweets ?? 0) + (stats.twitterStats?.quotes ?? 0);
        if (platform === 'LINKEDIN') totalShares += stats.linkedInStats?.reposts ?? 0;
        if (platform === 'FACEBOOK') totalShares += stats.facebookStats?.shares ?? 0;
        if (platform === 'INSTAGRAM') totalShares += stats.instagramStats?.shares ?? 0;
        if (platform === 'TIKTOK') totalShares += stats.tiktokStats?.shares ?? 0;
      });

      return {
        id: post.id,
        postContent: post.content, 
        createdAt: post.createdAt,
        status: post.status,
        destinationsCount: post.destinations.length, // Helpful for the UI
        likes: totalLikes,
        totalComments: totalComments,
        impressions: totalImpressions,
        reach: totalReach,
        shares: totalShares,
      };
    });
    const nextCursor = posts.length === take ? posts[posts.length - 1].id : null;
    return { items, nextCursor };
  }

  private async resolveOAuth2Creds(
    dest: any,
  ): Promise<{ accessToken: string }> {
    // 1. Find the encrypted token.
    // Depending on your database schema, the token might be saved directly on the
    // SocialProfile, or it might be inherited from the parent SocialConnection.
    const encryptedToken =
      dest.profile?.accessToken ?? dest.profile?.connection?.accessToken;

    // 2. Fail fast if the user's account is disconnected or missing a token
    if (!encryptedToken) {
      throw new BadRequestException(
        `Your ${dest.profile?.platform} account (${dest.profile?.name}) is missing an access token. Please reconnect it.`,
      );
    }

    try {
      const rawAccessToken =
        await this.encryptionService.decrypt(encryptedToken);

      if (!rawAccessToken) {
        throw new Error('Decryption returned null or empty string');
      }

      return { accessToken: rawAccessToken };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Security Error: Could not decrypt credentials for ${dest.profile?.platform}. Please reconnect the account.`,
      );
    }
  }

  // --------------------------------------------------------
  // HELPER: TRIAL WATERMARK
  // --------------------------------------------------------
  private async applyTrialWatermark(workspaceId: string, postDtos: any[]) {
    // 1. Fetch Subscription Status
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { organization: { include: { subscription: true } } }
    });

    const isTrial = workspace?.organization?.subscription?.isTrial === true;
    
    // Exit immediately if they are on a paid plan
    if (!isTrial) return; 

    const watermark = `\n\nScheduled with Rooli-rooli.co`;

    // 2. Mutate the DTOs in place
    for (const dto of postDtos) {
      // A. Main Content
      if (dto.content) {
        dto.content = `${dto.content}${watermark}`;
      }

      // B. Overrides
      if (dto.overrides && dto.overrides.length > 0) {
        dto.overrides = dto.overrides.map((override: any) => ({
          ...override,
          content: `${override.content}${watermark}`
        }));
      }

      // C. Threads
      if (dto.threads && dto.threads.length > 0) {
        const lastIndex = dto.threads.length - 1;
        dto.threads[lastIndex].content = `${dto.threads[lastIndex].content}${watermark}`;
      }
    }
  }
}
