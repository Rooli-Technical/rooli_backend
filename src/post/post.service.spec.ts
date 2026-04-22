import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PostService } from './services/post.service';
import { PostFactory } from './services/post-factory.service';
import { DestinationBuilder } from './services/destination-builder.service';
import { RequiresUpgradeException } from '@/common/exceptions/requires-upgrade.exception';
import {
  createPrismaMock,
  createQueueMock,
  asQueue,
  buildUser,
  buildWorkspaceWithPlan,
  buildPost,
  PrismaServiceMock,
  QueueMock,
} from './__tests__/helpers/post-test.helpers';

describe('PostService', () => {
  let service: PostService;
  let prisma: PrismaServiceMock;
  let mediaIngestQueue: QueueMock;
  let publishingQueue: QueueMock;
  let postFactory: jest.Mocked<Partial<PostFactory>>;
  let destinationBuilder: jest.Mocked<Partial<DestinationBuilder>>;
  let queueService: { getNextAvailableSlots: jest.Mock };
  let domainEvents: { emit: jest.Mock };
  let planAccessService: { ensureFeatureAccess: jest.Mock };

  function freezeTime(iso: string) {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(iso));
  }

  beforeEach(() => {
    prisma = createPrismaMock();
    mediaIngestQueue = createQueueMock();
    publishingQueue = createQueueMock();

    postFactory = {
      createMasterPost: jest.fn(),
      createThreadPost: jest.fn(),
    };
    destinationBuilder = {
      preparePayloads: jest.fn().mockResolvedValue([]),
      saveDestinations: jest.fn(),
    };
    queueService = { getNextAvailableSlots: jest.fn() };
    domainEvents = { emit: jest.fn() };
    planAccessService = { ensureFeatureAccess: jest.fn() };

    service = new PostService(
      prisma as any,
      asQueue(mediaIngestQueue),
      asQueue(publishingQueue),
      postFactory as any,
      destinationBuilder as any,
      queueService as any,
      domainEvents as any,
      planAccessService as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ============================================================
  // createPost
  // ============================================================
  describe('createPost', () => {
    beforeEach(() => {
      prisma.workspace.findUnique.mockResolvedValue(
        buildWorkspaceWithPlan({
          tier: 'BUSINESS',
          features: { approvalWorkflow: true },
          roleSlug: 'admin',
          isTrial: false,
        }),
      );
      (postFactory.createMasterPost as jest.Mock).mockResolvedValue(
        buildPost({ id: 'post_1' }),
      );
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);

      await expect(
        service.createPost(buildUser(), 'ws_missing', {
          socialProfileIds: ['p1'],
          content: 'hi',
        } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('silently strips needsApproval on premium admins whose plan lacks the approval feature', async () => {
      prisma.workspace.findUnique.mockResolvedValue(
        buildWorkspaceWithPlan({
          tier: 'BUSINESS',
          features: {}, // approvalWorkflow not enabled
          roleSlug: 'admin',
        }),
      );
      freezeTime('2099-01-01T00:00:00Z');

      await service.createPost(buildUser(), 'ws_1', {
        socialProfileIds: ['p1'],
        content: 'hi',
        needsApproval: true,
        scheduledAt: '2099-01-01T10:00:00Z',
        timezone: 'UTC',
      } as any);

      const call = (postFactory.createMasterPost as jest.Mock).mock.calls[0];
      expect(call[4]).toBe('SCHEDULED');
      expect(prisma.postApproval.create).not.toHaveBeenCalled();
    });

    it('strips needsApproval on non-premium plans instead of upgrading them', async () => {
      prisma.workspace.findUnique.mockResolvedValue(
        buildWorkspaceWithPlan({
          tier: 'FREE',
          features: {},
          roleSlug: 'admin',
        }),
      );
      freezeTime('2099-01-01T00:00:00Z');

      await service.createPost(buildUser(), 'ws_1', {
        socialProfileIds: ['p1'],
        content: 'hi',
        needsApproval: true,
        scheduledAt: '2099-01-01T10:00:00Z',
        timezone: 'UTC',
      } as any);

      const call = (postFactory.createMasterPost as jest.Mock).mock.calls[0];
      expect(call[4]).toBe('SCHEDULED');
    });

    it('forces contributors on premium plans into the approval workflow', async () => {
      prisma.workspace.findUnique.mockResolvedValue(
        buildWorkspaceWithPlan({
          tier: 'ROCKET',
          features: { approvalWorkflow: true },
          roleSlug: 'contributor',
        }),
      );
      freezeTime('2099-01-01T00:00:00Z');

      await service.createPost(buildUser(), 'ws_1', {
        socialProfileIds: ['p1'],
        content: 'hi',
        needsApproval: false,
        scheduledAt: '2099-01-01T10:00:00Z',
        timezone: 'UTC',
      } as any);

      const call = (postFactory.createMasterPost as jest.Mock).mock.calls[0];
      expect(call[4]).toBe('PENDING_APPROVAL');
      expect(prisma.postApproval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          postId: 'post_1',
          requesterId: 'user_1',
          status: 'PENDING',
        }),
      });
      expect(domainEvents.emit).toHaveBeenCalledWith(
        'publishing.post.requires_approval',
        expect.objectContaining({ postId: 'post_1', workspaceId: 'ws_1' }),
      );
    });

    it('rejects when mediaIds reference media outside the workspace', async () => {
      prisma.mediaFile.findMany.mockResolvedValue([
        { id: 'm1', status: 'READY' },
      ]);

      await expect(
        service.createPost(buildUser(), 'ws_1', {
          socialProfileIds: ['p1'],
          content: 'hi',
          mediaIds: ['m1', 'm2'],
        } as any),
      ).rejects.toThrow(/Media file\(s\) not found/);
    });

    it('rejects FAILED media uploads', async () => {
      prisma.mediaFile.findMany.mockResolvedValue([
        { id: 'm1', status: 'FAILED' },
      ]);

      await expect(
        service.createPost(buildUser(), 'ws_1', {
          socialProfileIds: ['p1'],
          content: 'hi',
          mediaIds: ['m1'],
        } as any),
      ).rejects.toThrow(/failed media uploads/);
    });

    it('rejects past scheduled times outside the 5-minute tolerance window', async () => {
      freezeTime('2099-01-01T10:00:00Z');

      await expect(
        service.createPost(buildUser(), 'ws_1', {
          socialProfileIds: ['p1'],
          content: 'hi',
          scheduledAt: '2099-01-01T09:00:00Z',
          timezone: 'UTC',
        } as any),
      ).rejects.toThrow(/past/);
    });

    it('rejects auto-schedule when queue has no available slots', async () => {
      queueService.getNextAvailableSlots.mockResolvedValue([]);
      prisma.socialProfile.findMany.mockResolvedValue([]);

      await expect(
        service.createPost(buildUser(), 'ws_1', {
          socialProfileIds: ['p1'],
          content: 'hi',
          isAutoSchedule: true,
        } as any),
      ).rejects.toThrow(/No available queue slots/);
    });

    it('enqueues publish-post with delay after a successful scheduled create', async () => {
      freezeTime('2099-01-01T10:00:00Z');
      const scheduled = new Date('2099-01-01T11:00:00Z');
      (postFactory.createMasterPost as jest.Mock).mockResolvedValue(
        buildPost({ id: 'post_enq', scheduledAt: scheduled }),
      );

      await service.createPost(buildUser(), 'ws_1', {
        socialProfileIds: ['p1'],
        content: 'hi',
        scheduledAt: '2099-01-01T11:00:00Z',
        timezone: 'UTC',
      } as any);

      expect(publishingQueue.add).toHaveBeenCalledWith(
        'publish-post',
        { postId: 'post_enq' },
        expect.objectContaining({
          delay: 60 * 60 * 1000,
          jobId: 'post_enq',
          attempts: 3,
        }),
      );
    });

    it('applies the trial watermark when the organization is on a trial', async () => {
      prisma.workspace.findUnique.mockResolvedValueOnce(
        buildWorkspaceWithPlan({
          tier: 'BUSINESS',
          features: { approvalWorkflow: true },
          roleSlug: 'admin',
        }),
      );
      prisma.workspace.findUnique.mockResolvedValueOnce({
        organization: { subscription: { isTrial: true } },
      });
      freezeTime('2099-01-01T00:00:00Z');

      const dto: any = {
        socialProfileIds: ['p1'],
        content: 'original',
        scheduledAt: '2099-01-01T10:00:00Z',
        timezone: 'UTC',
      };

      await service.createPost(buildUser(), 'ws_1', dto);

      const factoryDto = (postFactory.createMasterPost as jest.Mock).mock
        .calls[0][3];
      expect(factoryDto.content).toMatch(/Rooli-rooli\.co/);
    });

    it('links the ai generation record when aiGenerationId is provided', async () => {
      freezeTime('2099-01-01T00:00:00Z');

      await service.createPost(buildUser(), 'ws_1', {
        socialProfileIds: ['p1'],
        content: 'hi',
        aiGenerationId: 'gen_1',
        scheduledAt: '2099-01-01T10:00:00Z',
        timezone: 'UTC',
      } as any);

      expect(prisma.aiGeneration.update).toHaveBeenCalledWith({
        where: { id: 'gen_1' },
        data: { postId: 'post_1' },
      });
    });
  });

  // ============================================================
  // saveDraft
  // ============================================================
  describe('saveDraft', () => {
    it('forces DRAFT status and strips scheduledAt / needsApproval', async () => {
      (postFactory.createMasterPost as jest.Mock).mockResolvedValue(
        buildPost({ id: 'draft_1', status: 'DRAFT' }),
      );

      await service.saveDraft(buildUser(), 'ws_1', {
        socialProfileIds: ['p1'],
        content: 'drafty',
        scheduledAt: '2099-01-01T10:00:00Z',
        needsApproval: true,
      } as any);

      const call = (postFactory.createMasterPost as jest.Mock).mock.calls[0];
      expect(call[4]).toBe('DRAFT');
      const dtoArg = call[3];
      expect(dtoArg.scheduledAt).toBeNull();
      expect(dtoArg.needsApproval).toBe(false);
      expect(dtoArg.isAutoSchedule).toBe(false);
    });

    it('does not prepare destinations when no social profiles selected', async () => {
      (postFactory.createMasterPost as jest.Mock).mockResolvedValue(
        buildPost({ id: 'draft_1', status: 'DRAFT' }),
      );

      await service.saveDraft(buildUser(), 'ws_1', {
        content: 'drafty',
        socialProfileIds: [],
      } as any);

      expect(destinationBuilder.preparePayloads).not.toHaveBeenCalled();
      expect(destinationBuilder.saveDestinations).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // getWorkspacePosts
  // ============================================================
  describe('getWorkspacePosts', () => {
    it('returns paginated results with stringified media sizes', async () => {
      prisma.post.findMany.mockResolvedValue([
        {
          id: 'p1',
          media: [
            {
              id: 'pm1',
              order: 0,
              mediaFile: {
                id: 'm1',
                url: 'u',
                mimeType: 'image/jpeg',
                size: BigInt(500),
              },
            },
          ],
          destinations: [],
        },
      ]);
      prisma.post.count.mockResolvedValue(1);

      const result = await service.getWorkspacePosts('ws_1', {
        page: 1,
        limit: 10,
      } as any);

      expect(result.meta).toEqual({
        page: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
      });
      expect(result.data[0].media[0].mediaFile.size).toBe('500');
    });

    it('filters root-level posts by status, contentType, and search', async () => {
      prisma.post.findMany.mockResolvedValue([]);
      prisma.post.count.mockResolvedValue(0);

      await service.getWorkspacePosts('ws_1', {
        page: 2,
        limit: 5,
        status: 'SCHEDULED',
        contentType: 'POST',
        search: 'launch',
      } as any);

      const whereArg = prisma.post.findMany.mock.calls[0][0].where;
      expect(whereArg).toMatchObject({
        workspaceId: 'ws_1',
        parentPostId: null,
        status: 'SCHEDULED',
        contentType: 'POST',
        content: { contains: 'launch' },
      });
      expect(prisma.post.findMany.mock.calls[0][0].skip).toBe(5);
      expect(prisma.post.findMany.mock.calls[0][0].take).toBe(5);
    });
  });

  // ============================================================
  // getOne
  // ============================================================
  describe('getOne', () => {
    it('throws NotFoundException for missing post', async () => {
      prisma.post.findFirst.mockResolvedValue(null);
      await expect(service.getOne('ws_1', 'pX')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the post with thread metadata spread onto destinations', async () => {
      prisma.post.findFirst.mockResolvedValue({
        id: 'p1',
        media: [],
        destinations: [
          { id: 'd1', metadata: { thread: [{ content: 'r1' }] } },
          { id: 'd2', metadata: null },
        ],
      });

      const result = await service.getOne('ws_1', 'p1');
      expect(result.destinations[0].thread).toEqual([{ content: 'r1' }]);
      expect(result.destinations[1].thread).toEqual([]);
    });
  });

  // ============================================================
  // updatePost
  // ============================================================
  describe('updatePost', () => {
    beforeEach(() => {
      prisma.workspace.findUnique.mockResolvedValue(
        buildWorkspaceWithPlan({
          tier: 'BUSINESS',
          features: { approvalWorkflow: true },
          roleSlug: 'admin',
        }),
      );
    });

    it('throws NotFoundException when post does not exist in workspace', async () => {
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(
        service.updatePost(buildUser(), 'ws_1', 'pX', {} as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects updates to PUBLISHING or PUBLISHED posts', async () => {
      prisma.post.findFirst.mockResolvedValue({
        id: 'p1',
        status: 'PUBLISHED',
        scheduledAt: null,
        parentPostId: null,
        content: 'old',
      });

      await expect(
        service.updatePost(buildUser(), 'ws_1', 'p1', {
          content: 'new',
        } as any),
      ).rejects.toThrow(/Cannot edit a post in progress/);
    });

    it('removes existing scheduled job and re-adds it for the new time', async () => {
      freezeTime('2099-01-01T10:00:00Z');
      prisma.post.findFirst.mockResolvedValue({
        id: 'p1',
        status: 'SCHEDULED',
        scheduledAt: new Date('2099-01-01T11:00:00Z'),
        parentPostId: null,
        content: 'old',
      });

      const newScheduled = new Date('2099-01-01T12:00:00Z');
      prisma.post.update.mockResolvedValue({
        id: 'p1',
        status: 'SCHEDULED',
        scheduledAt: newScheduled,
      });

      const existingJob = { remove: jest.fn() };
      publishingQueue.getJob.mockResolvedValue(existingJob);

      await service.updatePost(buildUser(), 'ws_1', 'p1', {
        content: 'new',
        scheduledAt: '2099-01-01T12:00:00Z',
        timezone: 'UTC',
        socialProfileIds: ['p1'],
      } as any);

      expect(existingJob.remove).toHaveBeenCalled();
      expect(publishingQueue.add).toHaveBeenCalledWith(
        'publish-post',
        { postId: 'p1' },
        expect.objectContaining({
          delay: 2 * 60 * 60 * 1000,
          jobId: 'p1',
        }),
      );
    });

    it('cascades scheduledAt updates to thread children when updating the root post', async () => {
      freezeTime('2099-01-01T10:00:00Z');
      prisma.post.findFirst.mockResolvedValue({
        id: 'root_1',
        status: 'SCHEDULED',
        scheduledAt: new Date('2099-01-01T11:00:00Z'),
        parentPostId: null,
        content: 'old',
      });
      prisma.post.update.mockResolvedValue({
        id: 'root_1',
        status: 'SCHEDULED',
        scheduledAt: new Date('2099-01-01T12:00:00Z'),
      });

      await service.updatePost(buildUser(), 'ws_1', 'root_1', {
        scheduledAt: '2099-01-01T12:00:00Z',
        timezone: 'UTC',
        socialProfileIds: ['p1'],
      } as any);

      expect(prisma.post.updateMany).toHaveBeenCalledWith({
        where: { parentPostId: 'root_1' },
        data: { scheduledAt: expect.any(Date) },
      });
    });
  });

  // ============================================================
  // deletePost
  // ============================================================
  describe('deletePost', () => {
    it('throws NotFoundException when post is missing', async () => {
      prisma.post.findFirst.mockResolvedValue(null);
      await expect(service.deletePost('ws_1', 'pX')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletes all descendants resolved via the recursive CTE and removes the queue job', async () => {
      prisma.post.findFirst.mockResolvedValue({
        id: 'p1',
        parentPostId: null,
      });
      prisma.$queryRaw.mockResolvedValue([{ id: 'p1' }, { id: 'p1_thread_1' }]);
      const existingJob = { remove: jest.fn() };
      publishingQueue.getJob.mockResolvedValue(existingJob);

      const result = await service.deletePost('ws_1', 'p1');

      expect(prisma.post.deleteMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws_1', id: { in: ['p1', 'p1_thread_1'] } },
      });
      expect(existingJob.remove).toHaveBeenCalled();
      expect(result).toEqual({ message: 'Post deleted successfully' });
    });

    it('uses the parent id for queue cleanup when deleting a child thread post', async () => {
      prisma.post.findFirst.mockResolvedValue({
        id: 'child_1',
        parentPostId: 'root_1',
      });
      prisma.$queryRaw.mockResolvedValue([{ id: 'root_1' }]);
      publishingQueue.getJob.mockResolvedValue(null);

      await service.deletePost('ws_1', 'child_1');

      expect(publishingQueue.getJob).toHaveBeenCalledWith('root_1');
    });

    it('swallows queue-cleanup failures — the DB delete already succeeded', async () => {
      prisma.post.findFirst.mockResolvedValue({
        id: 'p1',
        parentPostId: null,
      });
      prisma.$queryRaw.mockResolvedValue([{ id: 'p1' }]);
      publishingQueue.getJob.mockRejectedValue(new Error('redis down'));

      await expect(service.deletePost('ws_1', 'p1')).resolves.toEqual({
        message: 'Post deleted successfully',
      });
    });
  });

  // ============================================================
  // Approval flow
  // ============================================================
  describe('getPendingApprovals', () => {
    it('returns paginated pending approvals', async () => {
      prisma.postApproval.findMany.mockResolvedValue([{ id: 'a1' }]);
      prisma.postApproval.count.mockResolvedValue(1);

      const result = await service.getPendingApprovals('ws_1', {
        page: 1,
        limit: 10,
      });

      expect(result.meta.total).toBe(1);
      expect(prisma.postApproval.findMany.mock.calls[0][0].where).toMatchObject(
        {
          post: { workspaceId: 'ws_1' },
          status: 'PENDING',
        },
      );
    });
  });

  describe('reviewApproval', () => {
    it('throws NotFoundException when approval does not exist', async () => {
      prisma.postApproval.findFirst.mockResolvedValue(null);
      await expect(
        service.reviewApproval(
          { id: 'admin_1' } as any,
          'ws_1',
          'a1',
          'APPROVED',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when already reviewed', async () => {
      prisma.postApproval.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'APPROVED',
      });

      await expect(
        service.reviewApproval(
          { id: 'admin_1' } as any,
          'ws_1',
          'a1',
          'APPROVED',
        ),
      ).rejects.toThrow(/Already reviewed/);
    });

    it('pulls a fresh slot when approved post scheduledAt is in the past', async () => {
      freezeTime('2099-01-01T12:00:00Z');
      prisma.postApproval.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'PENDING',
        post: {
          id: 'p1',
          scheduledAt: new Date('2099-01-01T11:00:00Z'),
        },
      });
      const newSlot = new Date('2099-01-01T14:00:00Z');
      queueService.getNextAvailableSlots.mockResolvedValue([newSlot]);
      prisma.post.update.mockResolvedValue({
        id: 'p1',
        status: 'SCHEDULED',
        scheduledAt: newSlot,
      });

      await service.reviewApproval(
        { id: 'admin_1' } as any,
        'ws_1',
        'a1',
        'APPROVED',
        'lgtm',
      );

      expect(queueService.getNextAvailableSlots).toHaveBeenCalledWith(
        'ws_1',
        1,
      );
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: expect.objectContaining({
          status: 'SCHEDULED',
          scheduledAt: newSlot,
        }),
      });
      expect(publishingQueue.add).toHaveBeenCalled();
    });

    it('refuses to approve when the schedule is stale and no slots are available', async () => {
      freezeTime('2099-01-01T12:00:00Z');
      prisma.postApproval.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'PENDING',
        post: {
          id: 'p1',
          scheduledAt: new Date('2099-01-01T11:00:00Z'),
        },
      });
      queueService.getNextAvailableSlots.mockResolvedValue([]);

      await expect(
        service.reviewApproval(
          { id: 'admin_1' } as any,
          'ws_1',
          'a1',
          'APPROVED',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects -> sets post to DRAFT and removes the queue job', async () => {
      prisma.postApproval.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'PENDING',
        post: { id: 'p1', scheduledAt: null },
      });
      prisma.post.update.mockResolvedValue({
        id: 'p1',
        status: 'DRAFT',
        scheduledAt: null,
      });
      const job = { remove: jest.fn() };
      publishingQueue.getJob.mockResolvedValue(job);

      await service.reviewApproval(
        { id: 'admin_1' } as any,
        'ws_1',
        'a1',
        'REJECTED',
        'no',
      );

      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: expect.objectContaining({ status: 'DRAFT' }),
      });
      expect(job.remove).toHaveBeenCalled();
      expect(publishingQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('cancelApprovalRequest', () => {
    it('throws NotFoundException when the approval does not exist', async () => {
      prisma.postApproval.findFirst.mockResolvedValue(null);
      await expect(
        service.cancelApprovalRequest('user_1', 'ws_1', 'a1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('forbids cancellation by someone who is not the requester', async () => {
      prisma.postApproval.findFirst.mockResolvedValue({
        id: 'a1',
        requesterId: 'someone_else',
        postId: 'p1',
      });

      await expect(
        service.cancelApprovalRequest('user_1', 'ws_1', 'a1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deletes the approval and flips the post back to DRAFT when requester cancels', async () => {
      prisma.postApproval.findFirst.mockResolvedValue({
        id: 'a1',
        requesterId: 'user_1',
        postId: 'p1',
      });
      prisma.post.update.mockResolvedValue({ id: 'p1', status: 'DRAFT' });

      const result = await service.cancelApprovalRequest(
        'user_1',
        'ws_1',
        'a1',
      );

      expect(prisma.postApproval.delete).toHaveBeenCalledWith({
        where: { id: 'a1' },
      });
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { status: 'DRAFT' },
      });
      expect(result).toEqual({ id: 'p1', status: 'DRAFT' });
    });
  });

  // ============================================================
  // bulkSchedulePosts
  // ============================================================
  describe('bulkSchedulePosts', () => {
    beforeEach(() => {
      prisma.workspace.findUnique.mockResolvedValue(
        buildWorkspaceWithPlan({
          tier: 'BUSINESS',
          features: { approvalWorkflow: true, bulkScheduling: true },
          roleSlug: 'admin',
        }),
      );
    });

    it('requires bulkScheduling feature access first', async () => {
      (planAccessService.ensureFeatureAccess as jest.Mock).mockRejectedValue(
        new RequiresUpgradeException('bulkScheduling'),
      );

      await expect(
        service.bulkSchedulePosts(buildUser(), 'ws_1', {
          posts: [{ socialProfileIds: ['p1'], content: 'hi' }],
        } as any),
      ).rejects.toThrow(RequiresUpgradeException);
      expect(planAccessService.ensureFeatureAccess).toHaveBeenCalledWith(
        'ws_1',
        'bulkScheduling',
      );
    });

    it('fails fast when auto-schedule count exceeds available queue slots', async () => {
      queueService.getNextAvailableSlots.mockResolvedValue([
        new Date('2099-01-01T10:00:00Z'),
      ]);

      await expect(
        service.bulkSchedulePosts(buildUser(), 'ws_1', {
          posts: [
            { socialProfileIds: ['p1'], content: 'a', isAutoSchedule: true },
            { socialProfileIds: ['p1'], content: 'b', isAutoSchedule: true },
          ],
        } as any),
      ).rejects.toThrow(/Queue is full/);
    });

    it('addBulk enqueues only root scheduled posts and skips thread children', async () => {
      freezeTime('2099-01-01T09:00:00Z');

      (postFactory.createMasterPost as jest.Mock).mockResolvedValue(
        buildPost({
          id: 'master_1',
          status: 'SCHEDULED',
          scheduledAt: new Date('2099-01-01T10:00:00Z'),
          parentPostId: null,
        }),
      );
      (postFactory.createThreadPost as jest.Mock).mockResolvedValue(
        buildPost({
          id: 'thread_1',
          status: 'SCHEDULED',
          scheduledAt: new Date('2099-01-01T10:00:00Z'),
          parentPostId: 'master_1',
        }),
      );
      (destinationBuilder.preparePayloads as jest.Mock).mockResolvedValue([
        { platform: 'TWITTER', socialProfileId: 'p1' },
      ]);

      await service.bulkSchedulePosts(buildUser(), 'ws_1', {
        posts: [
          {
            socialProfileIds: ['p1'],
            content: 'hi',
            scheduledAt: '2099-01-01T10:00:00Z',
            timezone: 'UTC',
            threads: [{ content: 'reply' }],
          },
        ],
      } as any);

      expect(publishingQueue.addBulk).toHaveBeenCalledTimes(1);
      const jobs = publishingQueue.addBulk.mock.calls[0][0];
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data.postId).toBe('master_1');
    });
  });

  // ============================================================
  // listPostsWithMetrics
  // ============================================================
  describe('listPostsWithMetrics', () => {
    it('returns empty metrics when there are no destinations', async () => {
      prisma.post.findMany.mockResolvedValue([
        {
          id: 'p1',
          content: 'hi',
          createdAt: new Date(),
          status: 'PUBLISHED',
          destinations: [],
        },
      ]);

      const result = await service.listPostsWithMetrics({
        workspaceId: 'ws_1',
        take: 10,
      });

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'p1',
        likes: 0,
        impressions: 0,
        shares: 0,
      });
      expect(result.nextCursor).toBeNull();
    });

    it('aggregates per-platform shares correctly', async () => {
      prisma.post.findMany.mockResolvedValue([
        {
          id: 'p1',
          content: 'hi',
          createdAt: new Date(),
          status: 'PUBLISHED',
          destinations: [
            { id: 'd_tw', profile: { platform: 'TWITTER' } },
            { id: 'd_li', profile: { platform: 'LINKEDIN' } },
          ],
        },
      ]);
      prisma.$queryRaw.mockResolvedValue([
        {
          postDestinationId: 'd_tw',
          likes: 5,
          comments: 1,
          impressions: 100,
          reach: 80,
          retweets: 2,
          quotes: 1,
        },
        {
          postDestinationId: 'd_li',
          likes: 10,
          comments: 3,
          impressions: 200,
          reach: 150,
          linkedin_reposts: 4,
        },
      ]);

      const { items } = await service.listPostsWithMetrics({
        workspaceId: 'ws_1',
        take: 10,
      });

      expect(items[0]).toMatchObject({
        likes: 15,
        totalComments: 4,
        impressions: 300,
        reach: 230,
        shares: 2 + 1 + 4,
      });
    });

    it('returns a cursor when the page is full', async () => {
      const posts = Array.from({ length: 5 }, (_, i) => ({
        id: `p${i}`,
        content: 'hi',
        createdAt: new Date(),
        status: 'PUBLISHED',
        destinations: [],
      }));
      prisma.post.findMany.mockResolvedValue(posts);

      const result = await service.listPostsWithMetrics({
        workspaceId: 'ws_1',
        take: 5,
      });
      expect(result.nextCursor).toBe('p4');
    });
  });
});
