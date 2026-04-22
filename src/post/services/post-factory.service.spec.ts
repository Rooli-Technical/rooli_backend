import { PostFactory } from './post-factory.service';

describe('PostFactory', () => {
  let factory: PostFactory;
  let tx: {
    post: { create: jest.Mock };
    postMedia: { createMany: jest.Mock };
  };

  beforeEach(() => {
    factory = new PostFactory();
    tx = {
      post: { create: jest.fn() },
      postMedia: { createMany: jest.fn() },
    };
  });

  describe('createMasterPost', () => {
    it('creates a post with the DTO fields and status, attaching media in order', async () => {
      tx.post.create.mockResolvedValue({ id: 'post_1' });

      const dto: any = {
        content: 'hello',
        contentType: 'POST',
        scheduledAt: '2099-01-01T10:00:00Z',
        isAutoSchedule: false,
        timezone: 'UTC',
        campaignId: 'cmp_1',
        mediaIds: ['m1', 'm2'],
      };

      const result = await factory.createMasterPost(
        tx as any,
        'user_1',
        'ws_1',
        dto,
        'SCHEDULED' as any,
      );

      expect(tx.post.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 'ws_1',
          authorId: 'user_1',
          content: 'hello',
          contentType: 'POST',
          status: 'SCHEDULED',
          scheduledAt: new Date('2099-01-01T10:00:00Z'),
          isAutoSchedule: false,
          timezone: 'UTC',
          campaignId: 'cmp_1',
        }),
      });

      expect(tx.postMedia.createMany).toHaveBeenCalledWith({
        data: [
          { postId: 'post_1', mediaFileId: 'm1', order: 0 },
          { postId: 'post_1', mediaFileId: 'm2', order: 1 },
        ],
      });

      expect(result).toEqual({ id: 'post_1' });
    });

    it('passes scheduledAt=null when DTO has no schedule', async () => {
      tx.post.create.mockResolvedValue({ id: 'draft_1' });

      await factory.createMasterPost(
        tx as any,
        'user_1',
        'ws_1',
        { content: 'draft' } as any,
        'DRAFT' as any,
      );

      expect(tx.post.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ scheduledAt: null }),
      });
    });

    it('skips postMedia when mediaIds empty', async () => {
      tx.post.create.mockResolvedValue({ id: 'post_1' });

      await factory.createMasterPost(
        tx as any,
        'user_1',
        'ws_1',
        { content: 'hi', mediaIds: [] } as any,
        'DRAFT' as any,
      );

      expect(tx.postMedia.createMany).not.toHaveBeenCalled();
    });

    it('defaults isAutoSchedule to false when not provided', async () => {
      tx.post.create.mockResolvedValue({ id: 'post_1' });

      await factory.createMasterPost(
        tx as any,
        'user_1',
        'ws_1',
        { content: 'hi' } as any,
        'DRAFT' as any,
      );

      expect(tx.post.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isAutoSchedule: false }),
      });
    });
  });

  describe('createThreadPost', () => {
    it('inherits root scheduledAt, timezone, and campaignId on the child', async () => {
      tx.post.create.mockResolvedValue({ id: 'thread_1' });
      const rootAt = new Date('2099-01-01T10:00:00Z');

      await factory.createThreadPost(
        tx as any,
        'user_1',
        'ws_1',
        'parent_1',
        { content: 'reply', mediaIds: ['m1'] },
        'SCHEDULED' as any,
        rootAt,
        'UTC',
        'cmp_1',
      );

      expect(tx.post.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          parentPostId: 'parent_1',
          content: 'reply',
          contentType: 'THREAD',
          scheduledAt: rootAt,
          timezone: 'UTC',
          campaignId: 'cmp_1',
        }),
      });
      expect(tx.postMedia.createMany).toHaveBeenCalledWith({
        data: [{ postId: 'thread_1', mediaFileId: 'm1', order: 0 }],
      });
    });
  });
});
