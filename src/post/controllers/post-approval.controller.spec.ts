import { PostApprovalController } from './post-approval.controller';
import { PostService } from '../services/post.service';

describe('PostApprovalController', () => {
  let controller: PostApprovalController;
  let service: jest.Mocked<PostService>;

  beforeEach(() => {
    service = {
      getPendingApprovals: jest.fn(),
      reviewApproval: jest.fn(),
      cancelApprovalRequest: jest.fn(),
    } as any;

    controller = new PostApprovalController(service as any);
  });

  describe('findAll', () => {
    it('delegates pagination query to service.getPendingApprovals', async () => {
      service.getPendingApprovals.mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 10, total: 0, totalPages: 0 },
      } as any);

      await controller.findAll('ws_1', { page: 1, limit: 10 } as any);

      expect(service.getPendingApprovals).toHaveBeenCalledWith('ws_1', {
        page: 1,
        limit: 10,
      });
    });
  });

  describe('review', () => {
    it('passes req.user.userId, workspaceId, approvalId, status, notes to the service', async () => {
      service.reviewApproval.mockResolvedValue({ id: 'p1' } as any);
      const req = { user: { userId: 'admin_1' } };

      await controller.review(
        req as any,
        'ws_1',
        'a1',
        { status: 'APPROVED', notes: 'lgtm' } as any,
      );

      expect(service.reviewApproval).toHaveBeenCalledWith(
        'admin_1',
        'ws_1',
        'a1',
        'APPROVED',
        'lgtm',
      );
    });

    it('propagates REJECTED status without notes', async () => {
      service.reviewApproval.mockResolvedValue({ id: 'p1' } as any);
      const req = { user: { userId: 'admin_1' } };

      await controller.review(
        req as any,
        'ws_1',
        'a1',
        { status: 'REJECTED' } as any,
      );

      expect(service.reviewApproval).toHaveBeenCalledWith(
        'admin_1',
        'ws_1',
        'a1',
        'REJECTED',
        undefined,
      );
    });
  });

  describe('cancel', () => {
    it('delegates to service.cancelApprovalRequest with req.user.userId', async () => {
      service.cancelApprovalRequest.mockResolvedValue({ id: 'p1' } as any);
      const req = { user: { userId: 'user_1' } };

      await controller.cancel(req as any, 'ws_1', 'a1');

      expect(service.cancelApprovalRequest).toHaveBeenCalledWith(
        'user_1',
        'ws_1',
        'a1',
      );
    });
  });
});
