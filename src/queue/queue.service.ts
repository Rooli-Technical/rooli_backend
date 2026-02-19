import { PrismaService } from '@/prisma/prisma.service';
import { Platform, PostStatus } from '@generated/enums';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { AutoScheduleDto } from './dtos/auto-schedule.dto';
import { CreateQueueSlotDto } from './dtos/create-queue-slot.dto';
import { PreviewQueueDto } from './dtos/preview-queue.dto';
import { RebuildQueueDto } from './dtos/rebuild-queue.dto';
import { UpdateQueueSlotDto } from './dtos/update-queue-slot.dto';
import { Prisma } from '@generated/client';
import { TIER_LIMITS } from './constants/tier-limits';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

type Slot = {
  id: string;
  dayOfWeek: number; // 1..7
  time: string; // "HH:mm"
  platform: string | null;
  capacity: number;
  isActive: boolean;
};

@Injectable()
export class QueueSlotService {
  private readonly logger = new Logger(QueueSlotService.name);
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('publishing-queue') private publishingQueue: Queue,
  ) {}

  // =========================================================
  // 1) CRUD
  // =========================================================
  async createQueueSlot(workspaceId: string, dto: CreateQueueSlotDto) {
    this.normalizeDay(dto.dayOfWeek);
    this.parseTimeHHmm(dto.time);

    const { tier } = await this.getWorkspaceTierAndZone(workspaceId);
    const limits = TIER_LIMITS[tier];

    const currentCount = await this.prisma.queueSlot.count({
      where: { workspaceId },
    });
    if (currentCount >= limits.maxQueueSlots) {
      throw new ForbiddenException(
        `Plan limit reached: ${limits.maxQueueSlots} slots max.`,
      );
    }

    // Prevent duplicates (same day+time+platform)
    const exists = await this.prisma.queueSlot.findFirst({
      where: {
        workspaceId,
        dayOfWeek: dto.dayOfWeek,
        time: dto.time,
        platform: dto.platform ?? null,
      } as any,
      select: { id: true },
    });

    if (exists)
      throw new BadRequestException(
        'A slot already exists for this day/time/platform',
      );

    return await this.prisma.queueSlot.create({
      data: {
        workspaceId,
        dayOfWeek: dto.dayOfWeek,
        time: dto.time,
        platform: dto.platform ?? null,
        capacity: Math.max(dto.capacity ?? 1, 1),
        isActive: dto.isActive ?? true,
      } as any,
    });
  }

  async listQueueSlots(workspaceId: string, platform?: Platform | null) {
    return await this.prisma.queueSlot.findMany({
      where: {
        workspaceId,
        ...(platform === undefined
          ? {}
          : platform === null
            ? { platform: null }
            : { platform }),
      } as any,
      orderBy: [{ dayOfWeek: 'asc' }, { time: 'asc' }],
    });
  }

  async getQueueSlot(workspaceId: string, slotId: string) {
    const slot = await this.prisma.queueSlot.findFirst({
      where: { id: slotId, workspaceId } as any,
    });
    if (!slot) throw new NotFoundException('Queue slot not found');
    return slot;
  }

  async updateQueueSlot(
    workspaceId: string,
    slotId: string,
    dto: UpdateQueueSlotDto,
  ) {
    const existing = await this.getQueueSlot(workspaceId, slotId);

    const dayOfWeek = dto.dayOfWeek ?? (existing as any).dayOfWeek;
    const time = dto.time ?? (existing as any).time;
    const platform =
      dto.platform === undefined
        ? (existing as any).platform
        : (dto.platform ?? null);

    this.normalizeDay(dayOfWeek);
    this.parseTimeHHmm(time);

    // Prevent duplicates
    const dup = await this.prisma.queueSlot.findFirst({
      where: {
        workspaceId,
        dayOfWeek,
        time,
        platform,
        NOT: { id: slotId },
      } as any,
      select: { id: true },
    });
    if (dup)
      throw new BadRequestException(
        'A slot already exists for this day/time/platform',
      );

    const updatedSlot = await this.prisma.queueSlot.update({
      where: { id: slotId } as any,
      data: {
        dayOfWeek,
        time,
        platform,
        capacity:
          dto.capacity === undefined
            ? (existing as any).capacity
            : Math.max(dto.capacity ?? 1, 1),
        isActive:
          dto.isActive === undefined
            ? (existing as any).isActive
            : dto.isActive,
      } as any,
    });

    await this.rebuildQueue(workspaceId, {
      platform: updatedSlot.platform,
    });
    return updatedSlot;
  }

  async deleteQueueSlot(workspaceId: string, slotId: string) {
    const slot = await this.getQueueSlot(workspaceId, slotId);

    await this.prisma.queueSlot.delete({ where: { id: slotId } as any });

    await this.rebuildQueue(workspaceId, { platform: slot.platform });

    return { ok: true };
  }

  // =========================================================
  // 2) Queue Engine Endpoints
  // =========================================================

  async getNextAvailableSlotTime(
    workspaceId: string,
    platform?: Platform | null,
    fromIso?: string,
  ) {
    const { zone } = await this.getWorkspaceTierAndZone(workspaceId);

    const from = fromIso
      ? DateTime.fromISO(fromIso, { zone })
      : DateTime.now().setZone(zone);

    if (!from.isValid) throw new BadRequestException('Invalid from datetime');

    const days = 30;

    const slots = await this.getActiveSlots(workspaceId, platform);
    if (!slots.length)
      throw new BadRequestException('No active queue slots found');

    const slotMap = this.groupSlotsByDay(slots);

    // Only load taken posts in the lookahead window
    const end = from.plus({ days });
    const taken = await this.getTakenMap(workspaceId, from, end, platform);

    const next = this.findNextFreeCandidate({
      from,
      end,
      zone,
      slotMap,
      taken,
    });
    if (!next)
      throw new BadRequestException(`Queue is full for the next ${days} days`);
    return next.toJSDate();
  }

  /**
   * POST preview next N candidate times
   */
  async previewNextSlots(workspaceId: string, dto: PreviewQueueDto) {
    const { zone } = await this.getWorkspaceTierAndZone(workspaceId);

    const from = dto.from
      ? DateTime.fromISO(dto.from, { zone })
      : DateTime.now().setZone(zone);

    if (!from.isValid) throw new BadRequestException('Invalid from datetime');

    const days = Math.min(Math.max(dto.days ?? 30, 1), 90);
    const count = Math.min(Math.max(dto.count ?? 10, 1), 50);
    const platform = dto.platform ?? null;

    const slots = await this.getActiveSlots(workspaceId, platform);
    if (!slots.length)
      throw new BadRequestException('No active queue slots found');

    const slotMap = this.groupSlotsByDay(slots);
    const end = from.plus({ days });

    const taken = await this.getTakenMap(workspaceId, from, end, platform);

    const results: string[] = [];
    let cursor = from;

    // Iterate day-by-day collecting candidates until we have `count`
    for (let i = 0; i <= days && results.length < count; i++) {
      const daySlots = slotMap.get(cursor.weekday) ?? [];
      for (const slot of daySlots) {
        const { hour, minute } = this.parseTimeHHmm(slot.time);
        const candidate = cursor.set({
          hour,
          minute,
          second: 0,
          millisecond: 0,
        });

        if (candidate <= from) continue;

        const key = candidate.toUTC().toMillis();
        const used = taken.get(key) ?? 0;

        if (used < slot.capacity) {
          results.push(candidate.toUTC().toISO()!); // store as UTC ISO
          // “reserve” in-memory so preview doesn’t repeat the same time
          taken.set(key, used + 1);
          if (results.length >= count) break;
        }
      }
      cursor = cursor.plus({ days: 1 }).startOf('day');
    }

    return { timezone: zone, from: from.toUTC().toISO(), results };
  }

  /**
   * POST auto-schedule: assigns scheduledAt to given postIds
   * - Uses the same candidate generator
   * - Writes updates in a transaction
   * - Avoids scheduling already scheduled posts
   */
  async autoSchedule(
    workspaceId: string,
    dto: AutoScheduleDto,
    tx?: Prisma.TransactionClient,
  ) {
    const prisma = tx ?? this.prisma;

    if (!dto.postIds?.length)
      throw new BadRequestException('postIds is required');

    // 1. GET TIER LIMITS 🛡️
    const { tier } = await this.getWorkspaceTierAndZone(workspaceId); // Returns 'CREATOR', 'BUSINESS', etc.
    const limits = TIER_LIMITS[tier];

    // 2. CHECK CURRENT QUEUE USAGE
    // Count posts that are currently SCHEDULED (in the queue)
    const currentQueueCount = await prisma.post.count({
      where: {
        workspaceId,
        status: 'SCHEDULED', // Only count scheduled items
      } as any,
    });

    // 3. CHECK NEW BATCH SIZE
    const newPostsCount = dto.postIds.length;

    if (currentQueueCount + newPostsCount > limits.maxPostsInQueue) {
      throw new ForbiddenException(
        `Queue limit reached. Your plan allows ${limits.maxPostsInQueue} queued posts. You currently have ${currentQueueCount}. Upgrade to add more.`,
      );
    }

    const { zone } = await this.getWorkspaceTierAndZone(workspaceId);
    const platform = dto.platform ?? null;

    const from = dto.from
      ? DateTime.fromISO(dto.from, { zone })
      : DateTime.now().setZone(zone);

    if (!from.isValid) throw new BadRequestException('Invalid from datetime');

    const days = Math.min(Math.max(dto.days ?? 30, 1), 90);
    const end = from.plus({ days });

    // ✅ use prisma (tx-aware)
    const postsToCheck = await prisma.post.findMany({
      where: { workspaceId, id: { in: dto.postIds } } as any,
      select: { id: true, scheduledAt: true },
    });

    const idsToSchedule = postsToCheck
      .filter((p) => !p.scheduledAt)
      .map((p) => p.id);
    if (!idsToSchedule.length) return { scheduled: [], skipped: dto.postIds };

    const plan = await this.planScheduleForPosts({
      workspaceId,
      postIds: idsToSchedule,
      platform,
      from,
      end,
      days,
      minSpacingMinutes: dto.minSpacingMinutes,
    });

    const updates = plan.scheduled.map((s) =>
      prisma.post.update({
        where: { id: s.postId } as any,
        data: {
          scheduledAt: new Date(s.scheduledAt),
          status: 'SCHEDULED',
        } as any,
      }),
    );

    // ✅ if tx exists, do sequential (no concurrent queries on tx)
    if (tx) {
      for (const q of updates) await q;
    } else {
      await this.prisma.$transaction(updates);
    }

    // ✅ sync jobs (and expose failures)
    const jobResults = await Promise.allSettled(
      plan.scheduled.map((s) =>
        this.refreshPostJob(s.postId, new Date(s.scheduledAt)),
      ),
    );

    const failed = jobResults.filter((r) => r.status === 'rejected');
    if (failed.length) {
      console.error('Queue sync failed for some posts', failed);
    }

    return plan;
  }

  /**
   * POST rebuild: reschedule posts in a window (useful after slot edits)
   * Strong opinion: only rebuild drafts/queued, not already published.
   */
  async rebuildQueue(workspaceId: string, dto: RebuildQueueDto) {
    const { zone } = await this.getWorkspaceTierAndZone(workspaceId);
    const platform = dto.platform ?? null;

    const from = dto.from
      ? DateTime.fromISO(dto.from, { zone })
      : DateTime.now().setZone(zone);

    if (!from.isValid) throw new BadRequestException('Invalid from datetime');

    const days = Math.min(Math.max(dto.days ?? 30, 1), 90);
    const end = from.plus({ days });

    const statuses = dto.statuses?.length
      ? dto.statuses
      : ['DRAFT', 'SCHEDULED'];

    // 1) Read candidates OUTSIDE tx
    const posts = await this.prisma.post.findMany({
      where: {
        workspaceId,
        status: { in: statuses as any },
        OR: [
          { scheduledAt: null },
          { scheduledAt: { gte: from.toJSDate(), lt: end.toJSDate() } },
        ],
      } as any,
      select: { id: true, scheduledAt: true },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    });

    if (!posts.length) return { scheduled: [], skipped: [] };

    const ids = posts.map((p) => p.id);

    // 2) Compute new schedule OUTSIDE tx (no DB writes)
    const plan = await this.planScheduleForPosts({
      workspaceId,
      postIds: ids,
      platform,
      from,
      end,
      days,
    });

    // 3) Apply updates in ONE batch transaction (fast)
    const queries = [
      // clear old schedules
      this.prisma.post.updateMany({
        where: { id: { in: ids } } as any,
        data: { scheduledAt: null, status: 'DRAFT' } as any,
      }),

      // apply new schedules
      ...plan.scheduled.map((s) =>
        this.prisma.post.update({
          where: { id: s.postId } as any,
          data: {
            scheduledAt: new Date(s.scheduledAt),
            status: 'SCHEDULED',
          } as any,
        }),
      ),
    ];

    await this.prisma.$transaction(queries);

    const syncPromises = plan.scheduled.map((s) =>
      this.refreshPostJob(s.postId, new Date(s.scheduledAt)),
    );

    await Promise.all(syncPromises).catch((err) =>
      console.error('Queue sync failed during rebuild', err),
    );
    return plan;
  }

  private async planScheduleForPosts(args: {
    workspaceId: string;
    postIds: string[];
    platform: Platform | null;
    from: DateTime;
    end: DateTime;
    days: number;
    minSpacingMinutes?: number;
  }) {
    const { workspaceId, postIds, platform, from, end, days } = args;
    const minSpacing = Math.max(args.minSpacingMinutes ?? 0, 0);

    // 1. Get Slots
    const slots = await this.getActiveSlots(workspaceId, platform);
    if (!slots.length)
      throw new BadRequestException('No active queue slots found');
    const slotMap = this.groupSlotsByDay(slots);

    // 2. Get Taken Map
    const taken = await this.getTakenMap(workspaceId, from, end, platform);

    const scheduled: Array<{ postId: string; scheduledAt: string }> = [];
    let cursor = from;

    for (const postId of postIds) {
      const candidate = this.findNextFreeCandidate({
        from: cursor,
        end,
        zone: from.zoneName,
        slotMap,
        taken,
      });

      if (!candidate) break;

      const key = candidate.toUTC().toMillis();

      // We update our local 'taken' map so the next post in this loop doesn't steal this spot
      taken.set(key, (taken.get(key) ?? 0) + 1);

      scheduled.push({ postId, scheduledAt: candidate.toUTC().toISO()! });

      cursor =
        minSpacing > 0 ? candidate.plus({ minutes: minSpacing }) : candidate;
    }

    if (scheduled.length === 0) {
      throw new BadRequestException(`Queue is full for the next ${days} days`);
    }

    return {
      scheduled,
      // Identify which IDs from the input list didn't get a slot
      skipped: postIds.filter((id) => !scheduled.some((s) => s.postId === id)),
    };
  }

  // =========================================================
  // Internal: taken map + candidate finder with capacity
  // =========================================================

  /**
   * takenMap: key=utcMillis, value=count scheduled at that exact time
   */
  private async getTakenMap(
    workspaceId: string,
    from: DateTime,
    end: DateTime,
    platform?: Platform | null,
  ) {
    // If you have per-platform slots and posts store platform, filter here.
    // If not, ignore platform.
    const posts = await this.prisma.post.findMany({
      where: {
        workspaceId,
        status: { in: [PostStatus.SCHEDULED] as any },
        scheduledAt: { gte: from.toJSDate(), lt: end.toJSDate() },
      } as any,
      select: { scheduledAt: true },
    });

    const map = new Map<number, number>();
    for (const p of posts) {
      if (!p.scheduledAt) continue;
      const key = p.scheduledAt.getTime();
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }

  private findNextFreeCandidate(args: {
    from: DateTime;
    end: DateTime;
    zone: string;
    slotMap: Map<number, Slot[]>;
    taken: Map<number, number>;
  }) {
    const { from, end, slotMap, taken } = args;
    const now = from; // already in workspace zone

    let cursor = from;

    while (cursor < end) {
      const daySlots = slotMap.get(cursor.weekday) ?? [];

      for (const slot of daySlots) {
        const { hour, minute } = this.parseTimeHHmm(slot.time);
        const candidate = cursor.set({
          hour,
          minute,
          second: 0,
          millisecond: 0,
        });

        if (candidate <= now) continue;

        const key = candidate.toUTC().toMillis();
        const used = taken.get(key) ?? 0;

        if (used < slot.capacity) {
          return candidate;
        }
      }

      cursor = cursor.plus({ days: 1 }).startOf('day');
    }

    return null;
  }

  /**
   * Internal Helper: Get N Date objects for the PostService to use during bulk creation
   */
  async getNextAvailableSlots(
    workspaceId: string,
    count: number,
    platform?: Platform | null,
  ): Promise<Date[]> {
    const { zone } = await this.getWorkspaceTierAndZone(workspaceId);
    const now = DateTime.now().setZone(zone);

    // Reuse your preview logic but strip the UI formatting
    const slots = await this.getActiveSlots(workspaceId, platform);
    if (!slots.length) return []; // Return empty if no slots

    const slotMap = this.groupSlotsByDay(slots);
    const end = now.plus({ days: 90 }); // Look ahead far enough

    const taken = await this.getTakenMap(workspaceId, now, end, platform);

    const results: Date[] = [];
    let cursor = now;

    while (cursor < end && results.length < count) {
      const daySlots = slotMap.get(cursor.weekday) ?? [];

      for (const slot of daySlots) {
        const { hour, minute } = this.parseTimeHHmm(slot.time);
        const candidate = cursor.set({
          hour,
          minute,
          second: 0,
          millisecond: 0,
        });

        if (candidate <= now) continue;

        const key = candidate.toUTC().toMillis();
        const used = taken.get(key) ?? 0;

        if (used < slot.capacity) {
          results.push(candidate.toJSDate());
          taken.set(key, used + 1);
          if (results.length >= count) break;
        }
      }
      cursor = cursor.plus({ days: 1 }).startOf('day');
    }

    return results;
  }

  async generateDefaultSlots(
    workspaceId: string,
    times: string[],
    days: number[] = [1, 2, 3, 4, 5],
    platform?: Platform | null,
  ) {
    const { tier } = await this.getWorkspaceTierAndZone(workspaceId);
    const limits = TIER_LIMITS[tier];

    // 1. Calculate count to create
    const countToCreate = times.length * days.length;
    const currentCount = await this.prisma.queueSlot.count({
      where: { workspaceId },
    });

    if (currentCount + countToCreate > limits.maxQueueSlots) {
      throw new ForbiddenException(
        `Plan limit reached. Your plan allows ${limits.maxQueueSlots} slots, but you're attempting to add ${countToCreate} more.`,
      );
    }

    // 2. Build the data array
    const data = [];
    for (const day of days) {
      for (const time of times) {
        data.push({
          workspaceId,
          dayOfWeek: day,
          time,
          platform: platform ?? null,
          capacity: 1,
          isActive: true,
        });
      }
    }

    // 3. Batch insert
    return await this.prisma.queueSlot.createMany({
      data,
      skipDuplicates: true,
    });
  }

  /**
   * Crisis Management: Unschedule all queued posts immediately
   */
  async clearQueue(workspaceId: string, platform?: Platform | null) {
    const now = new Date();

    // Step 1: Find IDs
    const postsToClear = await this.prisma.post.findMany({
      where: {
        workspaceId,
        status: { in: [PostStatus.SCHEDULED] },
        scheduledAt: { gte: now },
        ...(platform && {
          destinations: {
            some: {
              profile: {
                platform: platform,
              },
            },
          },
        }),
      },
      select: { id: true },
    });

    const ids = postsToClear.map((p) => p.id);
    if (ids.length === 0) return { count: 0 };

    // Step 2: Atomic Update
    const result = await this.prisma.post.updateMany({
      where: { id: { in: ids } },
      data: {
        status: PostStatus.DRAFT,
        scheduledAt: null,
      },
    });

    return { count: result.count };
  }

  // =========================================================
  // Helpers
  // =========================================================
  private parseTimeHHmm(time: string): { hour: number; minute: number } {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!m) throw new BadRequestException('time must be HH:mm (24h)');
    return { hour: Number(m[1]), minute: Number(m[2]) };
  }

  private normalizeDay(dayOfWeek: number) {
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
      throw new BadRequestException('dayOfWeek must be 1..7 (Mon..Sun)');
    }
  }

  private async getWorkspaceTierAndZone(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        timezone: true,
        organization: {
          select: {
            subscription: { select: { plan: { select: { tier: true } } } },
          },
        },
      },
    });
    if (!ws) throw new NotFoundException('Workspace not found');

    const tier = (ws.organization?.subscription?.plan?.tier ??
      'CREATOR') as keyof typeof TIER_LIMITS;
    const zone = ws.timezone || 'UTC';
    return { tier, zone };
  }

  private async getActiveSlots(
    workspaceId: string,
    platform?: Platform | null,
  ): Promise<Slot[]> {
    return (await this.prisma.queueSlot.findMany({
      where: {
        workspaceId,
        isActive: true,
        // If no platform is specified, get everything
        ...(platform === undefined
          ? {}
          : {
              OR: [
                { platform: platform }, // Match specific (e.g., 'LINKEDIN')
                { platform: null }, // Match general/universal
              ],
            }),
      } as any,
      select: {
        id: true,
        dayOfWeek: true,
        time: true,
        platform: true,
        capacity: true,
        isActive: true,
      },
    })) as any;
  }

  /**
   * Build a map: "weekday" -> sorted slots by time
   */
  private groupSlotsByDay(slots: Slot[]) {
    const map = new Map<number, Slot[]>();
    for (const s of slots) {
      const list = map.get(s.dayOfWeek) ?? [];
      list.push(s);
      map.set(s.dayOfWeek, list);
    }
    for (const [k, list] of map.entries()) {
      list.sort((a, b) => a.time.localeCompare(b.time));
      map.set(k, list);
    }
    return map;
  }

  private async removePostJob(postId: string) {
    const job = await this.publishingQueue.getJob(postId);
    if (job) await job.remove();
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

  private async refreshPostJob(postId: string, runAt: Date) {
    // 1. Remove the old job (if it exists)
    await this.removePostJob(postId);

    // 2. Add the new job
    await this.schedulePostJob(postId, runAt);
  }
}
