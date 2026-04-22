import { BadRequestException } from '@nestjs/common';
import { DestinationBuilder } from './destination-builder.service';
import { PlatformRulesService } from './platform-rules.service';
import { createPrismaMock, PrismaServiceMock } from '../__tests__/helpers/post-test.helpers';

describe('DestinationBuilder', () => {
  let builder: DestinationBuilder;
  let prisma: PrismaServiceMock;
  let platformRules: jest.Mocked<PlatformRulesService>;

  beforeEach(() => {
    prisma = createPrismaMock();
    platformRules = {
      validateAndTransform: jest.fn(),
    } as any;
    builder = new DestinationBuilder(platformRules, prisma as any);
  });

  describe('preparePayloads', () => {
    it('throws when any profile is missing or not connected in the workspace', async () => {
      prisma.socialProfile.findMany.mockResolvedValue([
        { id: 'p1', platform: 'LINKEDIN', name: 'acc' },
      ]);

      await expect(
        builder.preparePayloads('ws_1', {
          socialProfileIds: ['p1', 'p2'],
          content: 'hi',
        } as any),
      ).rejects.toThrow(/do not belong to this workspace/);
    });

    it('builds a LinkedIn payload via platformRules and attaches media lookup', async () => {
      prisma.socialProfile.findMany.mockResolvedValue([
        { id: 'p1', platform: 'LINKEDIN', name: 'LI Account' },
      ]);
      prisma.mediaFile.findMany.mockResolvedValue([
        {
          id: 'm1',
          url: 'u',
          width: 100,
          height: 100,
          mimeType: 'image/jpeg',
          size: BigInt(100),
          duration: null,
        },
      ]);
      platformRules.validateAndTransform.mockReturnValue({
        isValid: true,
        finalContent: 'hi',
      });

      const payloads = await builder.preparePayloads('ws_1', {
        socialProfileIds: ['p1'],
        content: 'hi',
        mediaIds: ['m1'],
      } as any);

      expect(platformRules.validateAndTransform).toHaveBeenCalledWith(
        'hi',
        'LINKEDIN',
        expect.arrayContaining([
          expect.objectContaining({ id: 'm1', size: 100 }),
        ]),
        expect.any(Object),
      );
      expect(payloads).toEqual([
        {
          socialProfileId: 'p1',
          platform: 'LINKEDIN',
          status: 'SCHEDULED',
          contentOverride: 'hi',
          metadata: undefined,
        },
      ]);
    });

    it('applies per-profile content overrides', async () => {
      prisma.socialProfile.findMany.mockResolvedValue([
        { id: 'p1', platform: 'LINKEDIN', name: 'LI' },
      ]);
      prisma.mediaFile.findMany.mockResolvedValue([]);
      platformRules.validateAndTransform.mockImplementation(
        (content: string) => ({ isValid: true, finalContent: content }),
      );

      const payloads = await builder.preparePayloads('ws_1', {
        socialProfileIds: ['p1'],
        content: 'default',
        overrides: [{ socialProfileId: 'p1', content: 'override-text' }],
      } as any);

      expect(payloads[0].contentOverride).toBe('override-text');
    });

    it('rejects empty tweets in explicit Twitter threads', async () => {
      prisma.socialProfile.findMany.mockResolvedValue([
        { id: 'p1', platform: 'TWITTER', name: 'X acc' },
      ]);
      prisma.mediaFile.findMany.mockResolvedValue([]);

      await expect(
        builder.preparePayloads('ws_1', {
          socialProfileIds: ['p1'],
          content: '', // empty tweet 1
          threads: [{ content: 'reply' }],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('builds Twitter payload with explicit thread metadata (no autosplit)', async () => {
      prisma.socialProfile.findMany.mockResolvedValue([
        { id: 'p1', platform: 'TWITTER', name: 'X acc' },
      ]);
      prisma.mediaFile.findMany.mockResolvedValue([]);

      const payloads = await builder.preparePayloads('ws_1', {
        socialProfileIds: ['p1'],
        content: 'first tweet',
        threads: [{ content: 'reply one' }, { content: 'reply two' }],
      } as any);

      expect(platformRules.validateAndTransform).not.toHaveBeenCalled();
      expect(payloads[0]).toMatchObject({
        platform: 'TWITTER',
        contentOverride: 'first tweet',
        metadata: {
          thread: [
            { content: 'reply one', mediaIds: [], targetProfileIds: [] },
            { content: 'reply two', mediaIds: [], targetProfileIds: [] },
          ],
        },
      });
    });

    it('builds Twitter payload with autosplit threadChain when no explicit threads', async () => {
      prisma.socialProfile.findMany.mockResolvedValue([
        { id: 'p1', platform: 'TWITTER', name: 'X acc' },
      ]);
      prisma.mediaFile.findMany.mockResolvedValue([]);
      platformRules.validateAndTransform.mockReturnValue({
        isValid: true,
        finalContent: 'chunk1',
        threadChain: ['chunk2', 'chunk3'],
      });

      const payloads = await builder.preparePayloads('ws_1', {
        socialProfileIds: ['p1'],
        content: 'long content',
      } as any);

      expect(payloads[0]).toMatchObject({
        platform: 'TWITTER',
        contentOverride: 'chunk1',
        metadata: {
          thread: [
            { content: 'chunk2', mediaIds: [], targetProfileIds: [] },
            { content: 'chunk3', mediaIds: [], targetProfileIds: [] },
          ],
        },
      });
    });

    it('aggregates errors across multiple profiles into a single exception', async () => {
      prisma.socialProfile.findMany.mockResolvedValue([
        { id: 'p1', platform: 'LINKEDIN', name: 'LI 1' },
        { id: 'p2', platform: 'INSTAGRAM', name: 'IG 1' },
      ]);
      prisma.mediaFile.findMany.mockResolvedValue([]);
      platformRules.validateAndTransform
        .mockImplementationOnce(() => {
          throw new BadRequestException('LI failed');
        })
        .mockImplementationOnce(() => {
          throw new BadRequestException('IG failed');
        });

      await expect(
        builder.preparePayloads('ws_1', {
          socialProfileIds: ['p1', 'p2'],
          content: 'x',
        } as any),
      ).rejects.toThrow(/LI 1.*LI failed[\s\S]*IG 1.*IG failed/);
    });
  });

  describe('saveDestinations', () => {
    it('is a no-op when payloads are empty', async () => {
      await builder.saveDestinations(prisma as any, 'post_1', []);
      expect(prisma.postDestination.createMany).not.toHaveBeenCalled();
    });

    it('persists payloads with metadata mapping JsonNull when absent', async () => {
      await builder.saveDestinations(prisma as any, 'post_1', [
        {
          socialProfileId: 'p1',
          status: 'SCHEDULED',
          contentOverride: 'hi',
          // metadata omitted
        },
        {
          socialProfileId: 'p2',
          status: 'SCHEDULED',
          contentOverride: 'hi2',
          metadata: { thread: [{ content: 'r' }] },
        },
      ]);

      expect(prisma.postDestination.createMany).toHaveBeenCalledTimes(1);
      const arg = prisma.postDestination.createMany.mock.calls[0][0];
      expect(arg.data).toHaveLength(2);
      expect(arg.data[0]).toMatchObject({
        postId: 'post_1',
        socialProfileId: 'p1',
        status: 'SCHEDULED',
        contentOverride: 'hi',
      });
      expect(arg.data[1].metadata).toEqual({
        thread: [{ content: 'r' }],
      });
    });
  });
});
