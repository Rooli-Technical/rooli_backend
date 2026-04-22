import { PostController } from './controllers/post.controller';
import { PostService } from './services/post.service';
import { buildUser } from './__tests__/helpers/post-test.helpers';

describe('PostController', () => {
  let controller: PostController;
  let service: jest.Mocked<PostService>;

  beforeEach(() => {
    service = {
      createPost: jest.fn(),
      saveDraft: jest.fn(),
      getWorkspacePosts: jest.fn(),
      getOne: jest.fn(),
      updatePost: jest.fn(),
      deletePost: jest.fn(),
      listPostsWithMetrics: jest.fn(),
      bulkSchedulePosts: jest.fn(),
    } as any;

    controller = new PostController(service as any);
  });

  describe('create', () => {
    it('delegates to service.createPost with req.user, workspaceId, and DTO', async () => {
      service.createPost.mockResolvedValue({ id: 'p1' } as any);
      const req = { user: buildUser() } as any;
      const dto: any = { socialProfileIds: ['p1'], content: 'hi' };

      const result = await controller.create(req, 'ws_1', dto);

      expect(service.createPost).toHaveBeenCalledWith(req.user, 'ws_1', dto);
      expect(result).toEqual({ id: 'p1' });
    });
  });

  describe('findAll', () => {
    it('forwards pagination query to the service', async () => {
      service.getWorkspacePosts.mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 10, total: 0, totalPages: 0 },
      } as any);
      const query: any = { page: 1, limit: 10 };

      await controller.findAll('ws_1', query);
      expect(service.getWorkspacePosts).toHaveBeenCalledWith('ws_1', query);
    });
  });

  describe('listPosts (metrics)', () => {
    it('defaults take to 50 when not provided', async () => {
      service.listPostsWithMetrics.mockResolvedValue({
        items: [],
        nextCursor: null,
      } as any);

      await controller.listPosts('ws_1');
      expect(service.listPostsWithMetrics).toHaveBeenCalledWith({
        workspaceId: 'ws_1',
        take: 50,
        cursor: undefined,
      });
    });

    it('parses take as integer', async () => {
      service.listPostsWithMetrics.mockResolvedValue({
        items: [],
        nextCursor: null,
      } as any);

      await controller.listPosts('ws_1', '25', 'cur_1');
      expect(service.listPostsWithMetrics).toHaveBeenCalledWith({
        workspaceId: 'ws_1',
        take: 25,
        cursor: 'cur_1',
      });
    });
  });

  describe('getOne', () => {
    it('wraps service result in { data }', async () => {
      service.getOne.mockResolvedValue({ id: 'p1' } as any);

      const result = await controller.getOne('ws_1', 'p1');
      expect(service.getOne).toHaveBeenCalledWith('ws_1', 'p1');
      expect(result).toEqual({ data: { id: 'p1' } });
    });
  });

  describe('update', () => {
    it('wraps update result in { data }', async () => {
      service.updatePost.mockResolvedValue({ id: 'p1', status: 'SCHEDULED' } as any);
      const user = buildUser();

      const result = await controller.update('ws_1', 'p1', { content: 'x' } as any, user);

      expect(service.updatePost).toHaveBeenCalledWith(
        user,
        'ws_1',
        'p1',
        { content: 'x' },
      );
      expect(result).toEqual({ data: { id: 'p1', status: 'SCHEDULED' } });
    });
  });

  describe('delete', () => {
    it('wraps delete result in { data }', async () => {
      service.deletePost.mockResolvedValue({ message: 'Post deleted successfully' } as any);

      const result = await controller.delete('ws_1', 'p1');
      expect(service.deletePost).toHaveBeenCalledWith('ws_1', 'p1');
      expect(result).toEqual({ data: { message: 'Post deleted successfully' } });
    });
  });

  describe('executeBulkSchedule', () => {
    it('delegates bulk DTO to service.bulkSchedulePosts', async () => {
      service.bulkSchedulePosts.mockResolvedValue([] as any);
      const user = buildUser();
      const body: any = { posts: [{ socialProfileIds: ['p1'], content: 'hi' }] };

      await controller.executeBulkSchedule('ws_1', body, user);

      expect(service.bulkSchedulePosts).toHaveBeenCalledWith(user, 'ws_1', body);
    });
  });

  describe('saveDraft', () => {
    it('delegates to service.saveDraft', async () => {
      service.saveDraft.mockResolvedValue({ id: 'draft_1' } as any);
      const user = buildUser();

      await controller.saveDraft('ws_1', { content: 'drafty' } as any, user);

      expect(service.saveDraft).toHaveBeenCalledWith(
        user,
        'ws_1',
        { content: 'drafty' },
      );
    });
  });

  describe('error propagation', () => {
    it('propagates service exceptions to the caller', async () => {
      service.createPost.mockRejectedValue(new Error('boom'));

      await expect(
        controller.create({ user: buildUser() } as any, 'ws_1', {} as any),
      ).rejects.toThrow('boom');
    });
  });
});
