import { PrismaService } from '@/prisma/prisma.service';
import {
  PlanTier,
  Platform,
  PostStatus,
  Prisma,
  User,
} from '@generated/client';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
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
import { RetryPostDto } from '../dto/request/retry-post.dto';
import { TRIAL_WATERMARK } from '../post.constants';

@Injectable()
export class PostService {
  private readonly logger = new Logger(PostService.name);

  constructor(
    private prisma: PrismaService,
    @InjectQueue('media-ingest') private mediaIngestQueue: Queue,
    @InjectQueue('publishing-queue') private publishingQueue: Queue,
    private postFactory: PostFactory,
    private destinationBuilder: DestinationBuilder,
    private queueService: QueueSlotService,
    private readonly domainEvents: DomainEventsService,
    private readonly planAccessService: PlanAccessService,
  ) {}

  async createPost(user: any, workspaceId: string, dto: CreatePostDto) {
    await this.validateFeatures(user, dto, workspaceId);

    // 👇 NEW: Validate attached media
    await this.validateMediaAttachments(workspaceId, dto.mediaIds);

    // 🚨 Apply Watermark (Passing the single DTO in an array)
    await this.applyTrialWatermark(workspaceId, [dto]);

    const { finalScheduledAt, status } = await this.resolvePostSchedule(
      workspaceId,
      dto, // dto already has socialProfileIds, so platform detection works
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
        await this.createApproval(tx, post.id, user.userId);
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
        authorName: user.firstName
          ? `${user.firstName} ${user.lastName}`.trim()
          : 'A team member',
        snippet: dto.content ? dto.content.substring(0, 60) : 'a new post',
      });
    }

    return created;
  }

  async saveDraft(user: any, workspaceId: string, dto: UpdatePostDto) {
    await this.validateMediaAttachments(workspaceId, dto.mediaIds);
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
              where: { userId: user.userId },
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
    const userRoleSlug =
      ws.organization?.members[0]?.role?.slug?.toLowerCase() || 'contributor';

    // ==========================================
    // RULE 2: APPROVAL ENFORCEMENT
    // ==========================================
    const premiumTiers = ['BUSINESS', 'ROCKET', 'ENTERPRISE'];
    const isPremium = premiumTiers.includes(tier);

    // Identify lower-level employees (Adjust these slugs based on your DB!)
    const isLowerLevelEmployee = ['contributor', 'editor'].includes(
      userRoleSlug,
    );
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
          'Upgrade to Business Plan to use Approval Workflows',
        );
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
      parentPostId: null,
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
              status: true,
              errorMessage: true,
              platformUrl: true,
              publishedAt: true,
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
    await this.planAccessService.ensureFeatureAccess(
      workspaceId,
      'bulkScheduling',
    );
    await this.validateFeatures(user, dto, workspaceId);

    // 👇 NEW: Collect and validate all media across all posts at once
    const allMediaIds = dto.posts.flatMap((p) => p.mediaIds ?? []);
    if (allMediaIds.length > 0) {
      const uniqueMediaIds = [...new Set(allMediaIds)];
      await this.validateMediaAttachments(workspaceId, uniqueMediaIds);
    }

    // 🚨 Apply Watermark (Passing the single DTO in an array)
    await this.applyTrialWatermark(workspaceId, dto.posts);
    // 1) Precompute schedules + payloads (fail fast)
    const preparedPosts: Array<{
      dto: any;
      payloads: any[];
      status: PostStatus;
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
            data: {
              postId: post.id,
              requesterId: user.userId,
              status: 'PENDING',
            },
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
          attempts: 10,
          backoff: { type: 'exponential', delay: 20_000 },
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
    dto: UpdatePostDto,
  ) {
    const existing = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        parentPostId: true,
        content: true,
        contentType: true,
        // 👇 NEW: Need the current social profiles to rebuild destinations
        destinations: {
          select: {
            id: true,
            socialProfileId: true,
          },
        },
      },
    });

    if (!existing) throw new NotFoundException('Post not found');

    // 🚨 Block editing posts currently publishing or already succeeded
    if (existing.status === 'PUBLISHING' || existing.status === 'PUBLISHED') {
      throw new BadRequestException(
        'Cannot edit a post in progress or already published.',
      );
    }

    // 🚨 Partial success = block full edit, route them to editPublishedPost
    if (existing.status === 'PARTIAL') {
      throw new BadRequestException(
        'This post already published successfully on some platforms. Use the retry-failed-only endpoint instead to avoid duplicates.',
      );
    }

    // 👇 NEW: For FAILED posts, require an explicit decision
    if (existing.status === 'FAILED') {
      const isGoingToDraft = !dto.scheduledAt && !dto.isAutoSchedule;
      const isRescheduling = !!dto.scheduledAt || !!dto.isAutoSchedule;

      if (!isGoingToDraft && !isRescheduling) {
        throw new BadRequestException(
          'Editing a failed post requires either a new scheduledAt (to retry) or explicit save as draft.',
        );
      }
    }

    await this.validateFeatures(user, dto, workspaceId);

    if (dto.mediaIds !== undefined) {
      await this.validateMediaAttachments(workspaceId, dto.mediaIds);
    }

    // 👇 Build the merged DTO with existing values filling gaps
    const dtoWithDefaults = {
      ...dto,
      content: dto.content ?? existing.content,
      contentType: dto.contentType ?? existing.contentType,
      // If the user didn't send socialProfileIds, use the ones from existing destinations
      socialProfileIds:
        dto.socialProfileIds ??
        existing.destinations.map((d) => d.socialProfileId),
    };

    // Re-apply watermark (idempotent — won't double-apply)
    await this.applyTrialWatermark(workspaceId, [dtoWithDefaults]);

    const { finalScheduledAt, status } = await this.resolvePostSchedule(
      workspaceId,
      {
        ...dtoWithDefaults,
        needsApproval:
          existing.status === 'PENDING_APPROVAL' ||
          dtoWithDefaults.needsApproval,
      },
    );

    // 👇 NEW: Re-run destination preparation with the updated content
    // This runs platform validation, watermark, thread splitting, etc.
    const payloads = await this.destinationBuilder.preparePayloads(
      workspaceId,
      dtoWithDefaults,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      // 1. Update master post
      const post = await tx.post.update({
        where: { id: postId },
        data: {
          content: dtoWithDefaults.content,
          contentType: dtoWithDefaults.contentType,
          scheduledAt: finalScheduledAt,
          status,
        } as any,
      });

      // 2. Media updates
      if (dto.mediaIds) {
        await tx.postMedia.deleteMany({ where: { postId } as any });
        if (dto.mediaIds.length > 0) {
          await tx.postMedia.createMany({
            data: dto.mediaIds.map((mid, idx) => ({
              postId,
              mediaFileId: mid,
              order: idx,
            })),
          });
        }
      }

      // 3. Clean up ALL old destinations (Master + Threads) safely
      await tx.postDestination.deleteMany({
        where: { 
          post: { OR: [{ id: postId }, { parentPostId: postId }] } 
        }
      });

      // 4. Clean up old child threads
      await tx.post.deleteMany({
        where: { parentPostId: postId },
      });
      
      // 👇 THIS WAS MISSING: 5. Recreate Master Destinations 👇
      await this.destinationBuilder.saveDestinations(tx, postId, payloads);

      // 6. Recreate children from the updated DTO
      const twitterPayloads = payloads.filter((p) => p.platform === 'TWITTER');
      if (twitterPayloads.length > 0 && dtoWithDefaults.threads?.length > 0) {
        let previousPostId = postId;
        for (const threadItem of dtoWithDefaults.threads) {
          const threadPost = await this.postFactory.createThreadPost(
            tx,
            user.userId,
            workspaceId,
            previousPostId,
            threadItem,
            status,
            finalScheduledAt,
            dtoWithDefaults.timezone,
            dtoWithDefaults.campaignId,
          );
          await this.destinationBuilder.saveDestinations(
            tx,
            threadPost.id,
            twitterPayloads,
          );
          previousPostId = threadPost.id;
        }
      }

      return post;
    });

    // Queue management — same as before
    await this.removePostJob(updated.id);
    if (updated.status === 'SCHEDULED' && updated.scheduledAt) {
      await this.schedulePostJob(updated.id, updated.scheduledAt);
    }

    return updated;
  }

  // ===========================================================================
  // RETRY SINGLE DESTINATION
  // ===========================================================================
  async retryDestination(
    user: any,
    workspaceId: string,
    destinationId: string,
    dto: RetryPostDto,
  ) {
    // 1. Fetch the specific destination and its parent post
    const destination = await this.prisma.postDestination.findFirst({
      where: {
        id: destinationId,
        post: { workspaceId },
      },
      include: {
        post: {
          include: {
            media: {
              orderBy: { order: 'asc' },
              include: { mediaFile: true },
            },
          },
        },
        profile: true,
      },
    });

    if (!destination) throw new NotFoundException('Destination not found');

    // Prevent retrying posts that aren't failed
    if (destination.status === 'SUCCESS') {
      throw new BadRequestException(
        'This destination was already published successfully. Retrying would create a duplicate.',
      );
    }
    if (destination.status === 'PUBLISHING') {
      throw new BadRequestException(
        'This destination is currently publishing. Wait for it to complete.',
      );
    }
    if (destination.status !== 'FAILED') {
      throw new BadRequestException(
        `Cannot retry destination in status: ${destination.status}`,
      );
    }

    // 2. Resolve the new retry time
    const retryTime = await this.resolveRetryTime(workspaceId, dto);

    // 3. Build the payload for the NEW post
    // Fallback chain: DTO Override -> Original Destination Override -> Original Master Content
    const contentToUse =
      dto.contentOverride ??
      destination.contentOverride ??
      destination.post.content;
    const mediaToUse =
      dto.mediaIds ?? destination.post.media.map((m) => m.mediaFile.id);

    const retryCreateDto = {
      content: contentToUse,
      contentType: destination.post.contentType,
      mediaIds: mediaToUse,
      scheduledAt: retryTime.toISOString(),
      isAutoSchedule: false,
      socialProfileIds: [destination.socialProfileId], // 👈 ONLY target this specific profile
    };

    // 4. Create the new cloned post (this automatically handles BullMQ scheduling!)
    const newRetriedPost = await this.createPost(
      user,
      workspaceId,
      retryCreateDto as CreatePostDto,
    );

    // 5. Update the old destination so your UI knows it was handled
    // (We append a note to the error message so you don't have to alter your Prisma ENUMs right now)
    await this.prisma.postDestination.update({
      where: { id: destinationId },
      data: {
        errorMessage: `${destination.errorMessage ?? 'Failed'} (Retried)`,
      },
    });

    return {
      message: `Created a new post to retry ${destination.profile.platform} destination.`,
      originalDestinationId: destinationId,
      newPostId: newRetriedPost.id,
      platform: destination.profile.platform,
      scheduledAt: retryTime,
    };
  }

  // ===========================================================================
  // RETRY ALL FAILED DESTINATIONS
  // ===========================================================================
  async retryAllFailedDestinations(
    user: any,
    workspaceId: string,
    postId: string,
    dto: RetryPostDto,
  ) {
    // 1. Fetch the original post with ONLY the failed destinations
    const originalPost = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId },
      include: {
        media: {
          orderBy: { order: 'asc' },
          include: { mediaFile: true },
        },
        destinations: {
          where: { status: 'FAILED' },
          select: { id: true, socialProfileId: true, contentOverride: true },
        },
      },
    });

    if (!originalPost) throw new NotFoundException('Post not found');
    if (originalPost.destinations.length === 0) {
      throw new BadRequestException('No failed destinations to retry.');
    }

    // 2. Resolve the new retry time
    const retryTime = await this.resolveRetryTime(workspaceId, dto);

    // 3. Build the payload for the NEW post
    const retryCreateDto = {
      content: dto.contentOverride ?? originalPost.content,
      contentType: originalPost.contentType,
      mediaIds: dto.mediaIds ?? originalPost.media.map((m) => m.mediaFile.id),
      scheduledAt: retryTime.toISOString(),
      isAutoSchedule: false,
      // 👈 Map all the failed profile IDs
      socialProfileIds: originalPost.destinations.map((d) => d.socialProfileId),
    };

    // 4. Create the new cloned post
    const newRetriedPost = await this.createPost(
      user,
      workspaceId,
      retryCreateDto as CreatePostDto,
    );

    // 5. Mark the old destinations as handled
    await this.prisma.postDestination.updateMany({
      where: { postId: originalPost.id, status: 'FAILED' },
      data: {
        errorMessage: 'Failed (Retried)',
      },
    });

    return {
      message: `Created a new post to retry ${originalPost.destinations.length} failed destinations.`,
      originalPostId: originalPost.id,
      newPostId: newRetriedPost.id,
      retriedCount: originalPost.destinations.length,
      scheduledAt: retryTime,
    };
  }

  async deletePost(workspaceId: string, postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId },
      select: { id: true, parentPostId: true },
    });
    if (!post) throw new NotFoundException('Post not found');

    const rootId = post.parentPostId ?? post.id;
    const deleteIds = await this.collectDescendantPostIds(workspaceId, rootId);

    // 👇 DB delete FIRST. If this fails, queue job stays — safer than orphaning a SCHEDULED post.
    await this.prisma.post.deleteMany({
      where: { workspaceId, id: { in: deleteIds } } as any,
    });

    // 👇 Queue cleanup AFTER DB succeeds. If this fails, worst case
    // is a stale job that fires and finds no post — worker should no-op on missing post.
    await this.removePostJob(rootId).catch((err) =>
      this.logger.warn(`Failed to remove job for deleted post ${rootId}`, err),
    );

    return { message: 'Post deleted successfully' };
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
        const slots = await this.queueService.getNextAvailableSlots(
          workspaceId,
          1,
        );

        if (slots.length > 0) {
          finalScheduledAt = slots[0];
        } else {
          // 👇 Never silently publish. Force the approver to reschedule manually.
          throw new BadRequestException(
            isMissing
              ? 'No available queue slots to schedule this post. Please reschedule manually.'
              : "This post's scheduled time has passed and no queue slots are available. Please reschedule before approving.",
          );
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

      // Update Master Post
      const updated = await tx.post.update({
        where: { id: post.id },
        data: {
          status: status === 'APPROVED' ? 'SCHEDULED' : 'DRAFT',
          scheduledAt:
            status === 'APPROVED' ? finalScheduledAt : post.scheduledAt,
        },
      });

      // 👇 NEW: Sync thread children (Twitter threads have child posts)
      // Without this, child tweets stay stuck in PENDING_APPROVAL forever.
      await tx.post.updateMany({
        where: { parentPostId: post.id },
        data: {
          status: status === 'APPROVED' ? 'SCHEDULED' : 'DRAFT',
          scheduledAt:
            status === 'APPROVED' ? finalScheduledAt : post.scheduledAt,
        },
      });

      return updated;
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
      return await tx.post.update({
        where: { id: approval.postId },
        data: { status: 'DRAFT' },
      });
    });
  }

  /**
   * Resolves the final scheduled time and status for a post.
   * Handles three schedule modes:
   *   1. Auto-schedule with pre-fetched slot (bulk operations)
   *   2. Auto-schedule that needs a slot fetched (single create/update)
   *   3. Manual scheduled time (with timezone conversion)
   */
  private async resolvePostSchedule(
    workspaceId: string,
    dto: {
      isAutoSchedule?: boolean;
      scheduledAt?: string | Date | null;
      timezone?: string | null;
      needsApproval?: boolean;
      socialProfileIds?: string[]; // 👈 used to detect target platform for slot optimization
    },
    providedAutoSlot?: Date, // 👈 optional pre-fetched slot (used by bulk to avoid N queries)
  ): Promise<{ finalScheduledAt: Date | null; status: PostStatus }> {
    let finalScheduledAt: Date | null = null;

    // ===========================================
    // 1. DETERMINE THE DATE
    // ===========================================
    if (dto.isAutoSchedule) {
      if (providedAutoSlot) {
        // Caller already fetched the slot (bulk path)
        finalScheduledAt = providedAutoSlot;
      } else {
        // Fetch a slot ourselves — detect target platform first for smarter slot selection
        const targetPlatform = await this.detectTargetPlatform(
          workspaceId,
          dto.socialProfileIds,
        );

        const slots = await this.queueService.getNextAvailableSlots(
          workspaceId,
          1,
          targetPlatform as Platform, // null means "any platform slot"
        );

        if (!slots?.length) {
          throw new BadRequestException('No available queue slots found.');
        }
        finalScheduledAt = slots[0];
      }
    } else if (dto.scheduledAt) {
      // Manual schedule: require unambiguous datetime
      if (typeof dto.scheduledAt === 'string') {
        const hasUtcSuffix = dto.scheduledAt.endsWith('Z');
        const hasTimezoneOffset = /[+-]\d{2}:\d{2}$/.test(dto.scheduledAt);

        if (dto.timezone && !hasUtcSuffix && !hasTimezoneOffset) {
          // Frontend sent local time + timezone name (e.g. "2026-05-01T14:00:00" + "Africa/Lagos")
          finalScheduledAt = fromZonedTime(dto.scheduledAt, dto.timezone);
        } else if (hasUtcSuffix || hasTimezoneOffset) {
          // Frontend sent absolute time (e.g. "2026-05-01T13:00:00Z" or with "+01:00")
          finalScheduledAt = new Date(dto.scheduledAt);
        } else {
          // Ambiguous — reject instead of silently using server's local time
          throw new BadRequestException(
            'scheduledAt must include timezone info: either a UTC suffix (Z), a timezone offset (+01:00), or provide a `timezone` field.',
          );
        }
      } else {
        finalScheduledAt = dto.scheduledAt;
      }

      if (isNaN(finalScheduledAt.getTime())) {
        throw new BadRequestException('Invalid scheduledAt datetime.');
      }

      // Past date check with 5-minute tolerance for clock skew
      if (isBefore(finalScheduledAt, subMinutes(new Date(), 5))) {
        throw new BadRequestException('Scheduled time is in the past.');
      }
    }

    // ===========================================
    // 2. DETERMINE THE STATUS
    // ===========================================
    const status: PostStatus = dto.needsApproval
      ? 'PENDING_APPROVAL'
      : finalScheduledAt
        ? 'SCHEDULED'
        : 'DRAFT';

    return { finalScheduledAt, status };
  }

  /**
   * Detects the target platform from a list of social profile IDs.
   * Returns the platform if all profiles belong to the same one, otherwise null.
   * Null means the slot picker will use a "universal" slot.
   */
  private async detectTargetPlatform(
    workspaceId: string,
    socialProfileIds?: string[],
  ): Promise<string | null> {
    if (!socialProfileIds?.length) return null;

    const profiles = await this.prisma.socialProfile.findMany({
      where: {
        id: { in: socialProfileIds },
        workspaceId,
      },
      select: { platform: true },
      distinct: ['platform'],
    });

    // Only return a platform if ALL profiles share the same one
    return profiles.length === 1 ? profiles[0].platform : null;
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
        attempts: 10,
        backoff: { type: 'exponential', delay: 20_000 },
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
    // 👇 Single query. Postgres recursive CTE walks the entire tree at once.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE descendants AS (
      SELECT id, "parentPostId", "workspaceId"
      FROM "Post"
      WHERE id = ${rootId} AND "workspaceId" = ${workspaceId}
      UNION ALL
      SELECT p.id, p."parentPostId", p."workspaceId"
      FROM "Post" p
      INNER JOIN descendants d ON p."parentPostId" = d.id
      WHERE p."workspaceId" = ${workspaceId}
    )
    SELECT id FROM descendants
  `;

    return rows.map((r) => r.id);
  }

  async listPostsWithMetrics(params: {
    workspaceId: string;
    take: number;
    cursor?: string;
  }) {
    const { workspaceId, take, cursor } = params;

    // 1. Fetch posts + destinations (no snapshots yet)
    const posts = await this.prisma.post.findMany({
      where: { workspaceId, parentPostId: null },
      take,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        destinations: { include: { profile: true } },
      },
    });

    // 2. Collect all destination IDs
    const destIds = posts.flatMap((p) => p.destinations.map((d) => d.id));

    // 3. Fetch ALL latest snapshots in ONE query using DISTINCT ON (Postgres)
    // If not Postgres, use a window function or subquery pattern
    const latestSnapshots =
      destIds.length === 0
        ? []
        : await this.prisma.$queryRaw<any[]>`
  SELECT DISTINCT ON (s."postDestinationId") 
    s.*, 
    t.retweets, t.quotes,
    l.reposts as linkedin_reposts,
    f.shares as fb_shares,
    i.shares as ig_shares,
    tk.shares as tk_shares
  FROM "PostAnalyticsSnapshot" s
  LEFT JOIN "TwitterStats" t ON t."snapshotId" = s.id
  LEFT JOIN "LinkedInStats" l ON l."snapshotId" = s.id
  LEFT JOIN "FacebookStats" f ON f."snapshotId" = s.id
  LEFT JOIN "InstagramStats" i ON i."snapshotId" = s.id
  LEFT JOIN "TikTokStats" tk ON tk."snapshotId" = s.id
  WHERE s."postDestinationId" = ANY(${destIds}::text[])
  ORDER BY s."postDestinationId", s.day DESC
`;

    // 4. Index snapshots by destination ID for O(1) lookup
    const snapByDestId = new Map(
      latestSnapshots.map((s) => [s.postDestinationId, s]),
    );

    // 5. Aggregate in memory (same logic as before)
    const items = posts.map((post) => {
      let totalLikes = 0,
        totalComments = 0,
        totalImpressions = 0,
        totalReach = 0,
        totalShares = 0;

      post.destinations.forEach((dest) => {
        const stats = snapByDestId.get(dest.id);
        if (!stats) return;

        totalLikes += stats.likes ?? 0;
        totalComments += stats.comments ?? 0;
        totalImpressions += stats.impressions ?? 0;
        totalReach += stats.reach ?? 0;

        switch (dest.profile?.platform) {
          case 'TWITTER':
            totalShares += (stats.retweets ?? 0) + (stats.quotes ?? 0);
            break;
          case 'LINKEDIN':
            totalShares += stats.linkedin_reposts ?? 0;
            break;
          case 'FACEBOOK':
            totalShares += stats.fb_shares ?? 0;
            break;
          case 'INSTAGRAM':
            totalShares += stats.ig_shares ?? 0;
            break;
          case 'TIKTOK':
            totalShares += stats.tk_shares ?? 0;
            break;
        }
      });

      return {
        id: post.id,
        postContent: post.content,
        createdAt: post.createdAt,
        status: post.status,
        destinationsCount: post.destinations.length,
        likes: totalLikes,
        totalComments,
        impressions: totalImpressions,
        reach: totalReach,
        shares: totalShares,
      };
    });

    const nextCursor =
      posts.length === take ? posts[posts.length - 1].id : null;
    return { items, nextCursor };
  }

  // --------------------------------------------------------
  // HELPER: TRIAL WATERMARK
  // --------------------------------------------------------

  private async applyTrialWatermark(workspaceId: string, postDtos: any[]) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        organization: {
          select: { subscription: { select: { isTrial: true } } },
        },
      },
    });

    const isTrial = workspace?.organization?.subscription?.isTrial === true;
    if (!isTrial) return;

    const wm = TRIAL_WATERMARK;
    const append = (
      text: string | null | undefined,
    ): string | null | undefined => {
      if (!text) return text;
      // 👇 Idempotency guard: don't re-append if already present
      if (text.endsWith(wm)) return text;
      return `${text}${wm}`;
    };

    // 👇 Watermark ONCE per post, prioritizing the most visible location.
    // Priority: threads > overrides > main content.
    // Prevents double-watermarking when a post has both threads AND content.
    for (const dto of postDtos) {
      if (dto.threads?.length > 0) {
        // Thread post: watermark the LAST reply (most visible place)
        const last = dto.threads.length - 1;
        dto.threads[last].content = append(dto.threads[last].content);
      } else if (dto.overrides?.length > 0) {
        // Multi-platform post with overrides: watermark each override
        dto.overrides = dto.overrides.map((o: any) => ({
          ...o,
          content: append(o.content),
        }));
      } else if (dto.content) {
        // Simple post: watermark main content
        dto.content = append(dto.content);
      }
    }
  }

  /**
   * Validates that all attached media files exist in this workspace and aren't
   * in a FAILED state. PENDING_UPLOAD is allowed — the publish worker will
   * defer until the upload completes.
   */
  private async validateMediaAttachments(
    workspaceId: string,
    mediaIds?: string[],
  ): Promise<void> {
    if (!mediaIds?.length) return;

    const media = await this.prisma.mediaFile.findMany({
      where: {
        id: { in: mediaIds },
        workspaceId, // 👈 prevents cross-workspace media attachment
      },
      select: { id: true, status: true },
    });

    // Catch missing IDs — either they don't exist or belong to another workspace
    if (media.length !== mediaIds.length) {
      const foundIds = new Set(media.map((m) => m.id));
      const missing = mediaIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Media file(s) not found in this workspace: ${missing.join(', ')}`,
      );
    }

    // Reject FAILED uploads — the post can never publish
    const failed = media.filter((m) => m.status === 'FAILED');
    if (failed.length > 0) {
      throw new BadRequestException(
        `Cannot attach failed media uploads: ${failed.map((m) => m.id).join(', ')}`,
      );
    }

    // 👇 PENDING_UPLOAD is intentionally allowed here.
    // The publish worker will defer the job until status === READY.
  }

  /**
   * Determines when to retry based on the DTO.
   * Priority:
   *   1. isAutoSchedule → next available queue slot
   *   2. Explicit scheduledAt → validate future + timezone, use it
   *   3. Default → 30 seconds from now
   */
  private async resolveRetryTime(
    workspaceId: string,
    dto: RetryPostDto,
  ): Promise<Date> {
    // Priority 1: Auto-schedule
    if (dto.isAutoSchedule) {
      const slots = await this.queueService.getNextAvailableSlots(
        workspaceId,
        1,
      );
      if (!slots?.length) {
        throw new BadRequestException(
          'No available queue slots found for auto-schedule.',
        );
      }
      return slots[0];
    }

    // Priority 2: Explicit scheduledAt
    if (dto.scheduledAt) {
      const hasUtcSuffix = dto.scheduledAt.endsWith('Z');
      const hasTimezoneOffset = /[+-]\d{2}:\d{2}$/.test(dto.scheduledAt);

      let retryTime: Date;
      if (dto.timezone && !hasUtcSuffix && !hasTimezoneOffset) {
        retryTime = fromZonedTime(dto.scheduledAt, dto.timezone);
      } else if (hasUtcSuffix || hasTimezoneOffset) {
        retryTime = new Date(dto.scheduledAt);
      } else {
        throw new BadRequestException(
          'scheduledAt must include timezone info: UTC suffix (Z), offset (+01:00), or provide `timezone` field.',
        );
      }

      if (isNaN(retryTime.getTime())) {
        throw new BadRequestException('Invalid scheduledAt datetime.');
      }

      // Must be in the future (5-min tolerance for clock skew)
      if (isBefore(retryTime, subMinutes(new Date(), 5))) {
        throw new BadRequestException(
          'Retry scheduledAt must be in the future.',
        );
      }

      return retryTime;
    }

    // Priority 3: Default — 30 seconds from now
    return new Date(Date.now() + 30_000);
  }

  /**
   * Runs every 5 minutes.
   * Finds posts that are SCHEDULED but their scheduled time has passed.
   * If they aren't in the BullMQ queue, it requeues them.
   */
  //@Cron(CronExpression.EVERY_5_MINUTES)
  async sweepGhostPosts() {
    this.logger.log('Running ghost post reconciliation sweep...');

    // Buffer: 2 minutes ago.
    // We don't want to sweep posts that are exactly on time,
    // as the worker might literally be picking them up right now.
    const cutoffTime = new Date(Date.now() - 2 * 60 * 1000);

    // 1. Find all Master Posts that are "stuck"
    const stuckPosts = await this.prisma.post.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { lte: cutoffTime },
        parentPostId: null, // Only grab master posts
      },
      select: {
        id: true,
        scheduledAt: true,
      },
    });

    if (stuckPosts.length === 0) {
      return; // All good, nothing stuck.
    }

    this.logger.warn(
      `Found ${stuckPosts.length} potentially stuck SCHEDULED posts. Checking queue...`,
    );

    let requeuedCount = 0;

    for (const post of stuckPosts) {
      try {
        // 2. Check if the job actually exists in Redis
        // Because you used `jobId: post.id`, this is an instant O(1) lookup
        const job = await this.publishingQueue.getJob(post.id);

        if (!job) {
          // 3. The job is missing from Redis! (Redis crashed, was flushed, etc.)
          // We must requeue it immediately.
          this.logger.error(
            `Ghost post detected! Post ID ${post.id} missing from queue. Requeueing now.`,
          );

          await this.publishingQueue.add(
            'publish-post',
            { postId: post.id },
            {
              jobId: post.id,
              delay: 0, // It's already late, run immediately
              removeOnComplete: true,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
            },
          );
          requeuedCount++;
        } else {
          // The job IS in Redis. Check its state.
          const state = await job.getState();

          // If it's waiting/delayed/active, the worker is just backlogged. Leave it alone.
          // If it's failed, it should have updated the DB. Let's force a DB sync just in case.
          if (state === 'failed') {
            this.logger.warn(
              `Job ${post.id} failed in BullMQ but DB still says SCHEDULED. Marking as FAILED.`,
            );
            await this.prisma.post.update({
              where: { id: post.id },
              data: {
                status: 'FAILED',
                errorMessage: job.failedReason ?? 'Unknown BullMQ error',
              },
            });
          }
        }
      } catch (error) {
        this.logger.error(`Failed to reconcile post ${post.id}:`, error);
      }
    }

    if (requeuedCount > 0) {
      this.logger.log(`Successfully requeued ${requeuedCount} ghost posts.`);
    }
  }
}
