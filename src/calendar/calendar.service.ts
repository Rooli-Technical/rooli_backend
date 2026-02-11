import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateTime } from 'luxon';
import Holidays from 'date-holidays';
import { CalendarEventDto } from './dtos/calendar-event.dto';
import { CalendarInclude, GetCalendarQueryDto } from './dtos/get-calendar.dto';
import { OBSERVANCES } from './observances';

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  private parseIncludes(include?: string): CalendarInclude[] {
    if (!include?.trim()) return ['posts', 'campaigns', 'holidays'];

    const parts = include
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const allowed = new Set<CalendarInclude>([
      'posts',
      'campaigns',
      'holidays',
    ]);
    const result: CalendarInclude[] = [];

    for (const p of parts) {
      if (allowed.has(p as CalendarInclude)) result.push(p as CalendarInclude);
    }

    // default if user sent garbage
    return result.length ? result : ['posts', 'campaigns', 'holidays'];
  }

  private parseDateRangeOrThrow(from: string, to: string, zone: string) {
    const start = DateTime.fromISO(from, { zone }).startOf('day');
    const end = DateTime.fromISO(to, { zone }).startOf('day');

    if (!start.isValid) throw new BadRequestException('Invalid from date');
    if (!end.isValid) throw new BadRequestException('Invalid to date');
    if (end <= start) throw new BadRequestException('to must be after from');

    // hard safety: max 120 days range
    if (end.diff(start, 'days').days > 120) {
      throw new BadRequestException('Date range too large (max 120 days)');
    }

    return { start, end };
  }

  async getCalendar(workspaceId: string, query: GetCalendarQueryDto) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, timezone: true },
    });

    if (!ws) throw new NotFoundException('Workspace not found');

    const zone = ws.timezone || 'UTC';
    const includes = this.parseIncludes(query.include);
    const { start, end } = this.parseDateRangeOrThrow(
      query.from,
      query.to,
      zone,
    );

    const includeDrafts = query.includeDrafts === 'true';

    const [postEvents, campaignEvents, holidayEvents] = await Promise.all([
      includes.includes('posts')
        ? this.getPostEvents(
            workspaceId,
            start,
            end,
            zone,
            includeDrafts,
            query.platform,
          )
        : Promise.resolve([]),
      includes.includes('campaigns')
        ? this.getCampaignEvents(workspaceId, start, end)
        : Promise.resolve([]),
      includes.includes('holidays')
        ? this.getHolidayAndObservanceEvents(
            start,
            end,
            query.country,
            query.state,
            query.lang,
          )
        : Promise.resolve([]),
    ]);

    const events = [...postEvents, ...campaignEvents, ...holidayEvents].sort(
      (a, b) => a.start.localeCompare(b.start),
    );

    return {
      workspaceId: ws.id,
      timezone: zone,
      from: query.from,
      to: query.to,
      events,
    };
  }

  private async getPostEvents(
    workspaceId: string,
    start: DateTime,
    end: DateTime,
    zone: string,
    includeDrafts: boolean,
    platform?: string,
  ): Promise<CalendarEventDto[]> {
    const nowInZone = DateTime.now().setZone(zone);
    const fallbackDate = (nowInZone >= start && nowInZone < end) ? nowInZone : start;

    // 2. Build the query
    const where: any = {
      workspaceId,
      ...(platform ? { platform } : {}),
      OR: [
        // Scheduled posts within the visible range
        { scheduledAt: { gte: start.toJSDate(), lt: end.toJSDate() } },
        // Optionally include drafts that have NO date
        ...(includeDrafts ? [{ scheduledAt: null, status: 'DRAFT' }] : []),
      ],
    };
    const posts = await this.prisma.post.findMany({
      where,
      select: {
        id: true,
        content: true,
        status: true,
        scheduledAt: true,
        timezone: true,
        platform: true,
        campaignId: true,
      } as any,
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    });

   // 3. Map to Calendar Events
    return posts.map((p: any) => {
      // Convert DB Date to UTC ISO for the frontend
      const scheduledIso = p.scheduledAt 
        ? DateTime.fromJSDate(p.scheduledAt).toUTC().toISO() 
        : null;

      // If it's a draft, use the fallback date (Today or Start of Month)
      const eventStart = scheduledIso ?? fallbackDate.toUTC().toISO()!;

      const title = this.compactTitle(p.content, p.platform, p.status);

      return {
        id: `post_${p.id}`,
        type: 'POST',
        title: p.status === 'DRAFT' ? `📝 [DRAFT] ${title}` : title,
        start: eventStart,
        allDay: false,
        color: this.postColor(p.status),
        meta: {
          postId: p.id,
          status: p.status,
          platform: p.platform,
          scheduledAt: scheduledIso,
          timezone: p.timezone ?? zone,
          campaignId: p.campaignId ?? null,
        },
      } satisfies CalendarEventDto;
    });
  }

  private async getCampaignEvents(
    workspaceId: string,
    start: DateTime,
    end: DateTime,
  ): Promise<CalendarEventDto[]> {
    // campaigns that overlap the range:
    // startDate < rangeEnd AND (endDate is null OR endDate >= rangeStart)
    const campaigns = await this.prisma.campaign.findMany({
      where: {
        workspaceId,
        startDate: { lt: end.toJSDate() },
        OR: [{ endDate: null }, { endDate: { gte: start.toJSDate() } }],
      } as any,
      select: {
        id: true,
        name: true,
        color: true,
        startDate: true,
        endDate: true,
        status: true,
      },
      orderBy: { startDate: 'asc' },
    });

    return campaigns.map((c: any) => {
      const s = DateTime.fromJSDate(c.startDate).toISODate()!;
      // FullCalendar all-day end is typically exclusive; many UIs prefer end+1 day.
      // We'll keep it simple: if endDate exists, use ISO date.
      const e = c.endDate
        ? DateTime.fromJSDate(c.endDate).toISODate()!
        : undefined;

      return {
        id: `campaign_${c.id}`,
        type: 'CAMPAIGN',
        title: c.name,
        start: s,
        end: e,
        allDay: true,
        color: c.color ?? '#1877F2',
        meta: {
          campaignId: c.id,
          status: c.status,
        },
      } satisfies CalendarEventDto;
    });
  }

  private getHolidayAndObservanceEvents(
    start: DateTime,
    end: DateTime,
    country?: string,
    state?: string,
    lang?: string,
  ): CalendarEventDto[] {
    const events: CalendarEventDto[] = [];

    // 1) Public holidays (country-based)
    if (country) {
      try {
        const hd = new Holidays(
          country,
          state ? ({ state } as any) : undefined,
        );
        if (lang) {
          try {
            // date-holidays supports languages, but depends on locale availability
            (hd as any).setLanguages(lang);
          } catch {
            // ignore
          }
        }

        // date-holidays uses JS Dates in local time; we convert to ISO date
        const fromDate = start.toJSDate();
        const toDate = end.toJSDate();
        const holidays = hd.getHolidays(fromDate.getFullYear());
        const holidayInRange = holidays.filter((h: any) => {
          const d = DateTime.fromISO(h.date).startOf('day');
          return d >= start.startOf('day') && d < end.startOf('day');
        });

        for (const h of holidayInRange) {
          events.push({
            id: `holiday_${country}_${h.date}_${this.slug(h.name)}`,
            type: 'HOLIDAY',
            title: h.name,
            start: DateTime.fromISO(h.date).toISODate()!,
            allDay: true,
            color: '#111827',
            meta: { country, type: h.type },
          });
        }
      } catch {
        // If invalid country code or library fails, just skip public holidays
      }
    }

    // 2) Observances (global marketing days)
    const years: number[] = [];
    for (let y = start.year; y <= end.year; y++) years.push(y);

    for (const y of years) {
      for (const ob of OBSERVANCES) {
        const d = DateTime.fromObject(
          { year: y, month: ob.month, day: ob.day },
          { zone: 'UTC' },
        );
        if (
          d >= start.toUTC().startOf('day') &&
          d < end.toUTC().startOf('day')
        ) {
          events.push({
            title: `${ob.emoji || '📅'} ${ob.name}`,
            id: `obs_${y}_${ob.key}`,
            type: 'OBSERVANCE',
            start: d.toISODate()!,
            allDay: true,
            color: ob.color ?? '#6B7280',
            meta: { key: ob.key },
          });
        }
      }
    }

    return events;
  }

  private compactTitle(content?: string, platform?: string, status?: string) {
    const base = (content ?? '').replace(/\s+/g, ' ').trim();
    const snippet =
      base.length > 40 ? base.slice(0, 40) + '…' : base || '(No content)';
    const p = platform ? `${platform}: ` : '';
    const s = status ? ` (${status})` : '';
    return `${p}${snippet}${s}`;
  }

  private postColor(status?: string) {
    // keep it simple: UI can override
    switch (status) {
      case 'PENDING_APPROVAL':
        return '#F59E0B';
      case 'SCHEDULED':
        return '#10B981';
      case 'PUBLISHED':
        return '#3B82F6';
      case 'FAILED':
        return '#EF4444';
      default:
        return '#6B7280';
    }
  }

  private slug(s: string) {
    return (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
}
