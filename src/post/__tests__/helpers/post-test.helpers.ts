import { Queue } from 'bullmq';

export type MockFn = jest.Mock;

export interface PrismaTxMock {
  post: {
    create: MockFn;
    update: MockFn;
    updateMany: MockFn;
    deleteMany: MockFn;
  };
  postMedia: {
    createMany: MockFn;
    deleteMany: MockFn;
  };
  postDestination: {
    createMany: MockFn;
  };
  postApproval: {
    create: MockFn;
    update: MockFn;
    delete: MockFn;
  };
  aiGeneration: {
    update: MockFn;
  };
}

export interface PrismaServiceMock extends PrismaTxMock {
  $transaction: MockFn;
  $queryRaw: MockFn;
  workspace: { findUnique: MockFn };
  socialProfile: { findMany: MockFn };
  mediaFile: { findMany: MockFn };
  post: PrismaTxMock['post'] & {
    findFirst: MockFn;
    findMany: MockFn;
    count: MockFn;
  };
  postApproval: PrismaTxMock['postApproval'] & {
    findFirst: MockFn;
    findMany: MockFn;
    count: MockFn;
  };
}

export function createPrismaMock(): PrismaServiceMock {
  const txMock: PrismaTxMock = {
    post: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    postMedia: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    postDestination: {
      createMany: jest.fn(),
    },
    postApproval: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    aiGeneration: {
      update: jest.fn(),
    },
  };

  const $transaction = jest.fn(async (argOrFn: any) => {
    if (typeof argOrFn === 'function') {
      return argOrFn(txMock);
    }
    // Array form: resolve each promise/value
    return Promise.all(argOrFn);
  });

  const prisma: any = {
    ...txMock,
    post: {
      ...txMock.post,
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    postApproval: {
      ...txMock.postApproval,
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    workspace: { findUnique: jest.fn() },
    socialProfile: { findMany: jest.fn() },
    mediaFile: { findMany: jest.fn() },
    $transaction,
    $queryRaw: jest.fn(),
  };

  return prisma as PrismaServiceMock;
}

export interface QueueMock {
  add: MockFn;
  addBulk: MockFn;
  getJob: MockFn;
}

export function createQueueMock(): QueueMock {
  return {
    add: jest.fn(),
    addBulk: jest.fn(),
    getJob: jest.fn(),
  };
}

export function asQueue(mock: QueueMock): Queue {
  return mock as unknown as Queue;
}

export function buildUser(overrides: Partial<any> = {}) {
  return {
    userId: 'user_1',
    id: 'user_1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    ...overrides,
  };
}

export function buildWorkspaceWithPlan(overrides: {
  tier?: string;
  features?: Record<string, boolean>;
  roleSlug?: string;
  isTrial?: boolean;
  workspaceId?: string;
  userId?: string;
} = {}) {
  const {
    tier = 'BUSINESS',
    features = { approvalWorkflow: true, bulkScheduling: true },
    roleSlug = 'admin',
    isTrial = false,
    workspaceId = 'ws_1',
    userId = 'user_1',
  } = overrides;

  return {
    id: workspaceId,
    organization: {
      subscription: {
        isTrial,
        plan: { tier, features },
      },
      members: [
        { userId, role: { slug: roleSlug } },
      ],
    },
  };
}

export function buildPost(overrides: Partial<any> = {}) {
  return {
    id: 'post_1',
    workspaceId: 'ws_1',
    authorId: 'user_1',
    content: 'Hello world',
    contentType: 'POST',
    status: 'SCHEDULED',
    scheduledAt: new Date('2099-01-01T10:00:00Z'),
    timezone: 'UTC',
    parentPostId: null,
    ...overrides,
  };
}
