import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

export interface StatCard {
  total: number;
  percentageChangeFromLastMonth: number;
}

export interface MonthlyPoint {
  month: 'JAN' | 'FEB' | 'MAR' | 'APR' | 'MAY' | 'JUN' | 'JUL' | 'AUG' | 'SEP' | 'OCT' | 'NOV' | 'DEC';
  year: number;
  count: number;
}

export interface UserDistributionResult {
  active: number;
  inactive: number;
  suspended: number;
}

export interface InfrastructureHealth {
  totalWorkspaces: number;
  queuedPosts: number;
  sentToday: number;
  failedJobs: number;
}

export interface WorkspaceGrowth {
  webhookSuccessRate: number;   // e.g. 98.7 (percentage of PROCESSED out of non-IGNORED)
  webhookTotal: number;         // total webhooks in the period
  webhookProcessed: number;     // successfully processed
  webhookFailed: number;        // failed webhooks
  // connectedAccounts: number;    // total active SocialProfiles (isActive = true)
}

export interface DateRange {
  dateFrom: Date;
  dateTo: Date;
}

// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;

@Injectable()
export class AdminDashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Shared helpers ─────────────────────────────────────────────────────────

  private percentageChange(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return parseFloat((((current - previous) / previous) * 100).toFixed(1));
  }

  private getPreviousPeriod(dateFrom: Date, dateTo: Date): { prevFrom: Date; prevTo: Date } {
    const durationMs = dateTo.getTime() - dateFrom.getTime();
    return {
      prevFrom: new Date(dateFrom.getTime() - durationMs),
      prevTo:   new Date(dateFrom.getTime()),
    };
  }

  private get todayStart() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  private get tomorrowStart() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  }

  private getMonthWindows(dateFrom: Date, dateTo: Date): { from: Date; to: Date }[] {
    const windows: { from: Date; to: Date }[] = [];
    const cursor = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), 1);
    const end    = new Date(dateTo.getFullYear(), dateTo.getMonth() + 1, 1);

    while (cursor < end) {
      const from = new Date(cursor);
      const to   = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      windows.push({ from, to });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return windows;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAT CARD 1 — "Total Users"
  // ─────────────────────────────────────────────────────────────────────────

  async getTotalUsersStatCard({ dateFrom, dateTo }: DateRange): Promise<StatCard> {
    const { prevFrom, prevTo } = this.getPreviousPeriod(dateFrom, dateTo);

    const [total, currentPeriod, previousPeriod] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: dateFrom, lte: dateTo } } }),
      this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: prevFrom, lt: prevTo } } }),
    ]);

    return { total, percentageChangeFromLastMonth: this.percentageChange(currentPeriod, previousPeriod) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAT CARD 2 — "Total Workspaces"
  // ─────────────────────────────────────────────────────────────────────────

  async getTotalWorkspacesStatCard({ dateFrom, dateTo }: DateRange): Promise<StatCard> {
    const { prevFrom, prevTo } = this.getPreviousPeriod(dateFrom, dateTo);

    const [total, currentPeriod, previousPeriod] = await Promise.all([
      this.prisma.workspace.count(),
      this.prisma.workspace.count({ where: { createdAt: { gte: dateFrom, lte: dateTo } } }),
      this.prisma.workspace.count({ where: { createdAt: { gte: prevFrom, lt: prevTo } } }),
    ]);

    return { total, percentageChangeFromLastMonth: this.percentageChange(currentPeriod, previousPeriod) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAT CARD 3 — "Connected Socials"
  // ─────────────────────────────────────────────────────────────────────────

  async getConnectedSocialsStatCard({ dateFrom, dateTo }: DateRange): Promise<StatCard> {
    const { prevFrom, prevTo } = this.getPreviousPeriod(dateFrom, dateTo);
    const base = { status: 'CONNECTED', isActive: true } as const;

    const [total, currentPeriod, previousPeriod] = await Promise.all([
      this.prisma.socialProfile.count({ where: base }),
      this.prisma.socialProfile.count({ where: { ...base, createdAt: { gte: dateFrom, lte: dateTo } } }),
      this.prisma.socialProfile.count({ where: { ...base, createdAt: { gte: prevFrom, lt: prevTo } } }),
    ]);

    return { total, percentageChangeFromLastMonth: this.percentageChange(currentPeriod, previousPeriod) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAT CARD 4 — "Monthly Recurring Revenue"
  // ─────────────────────────────────────────────────────────────────────────

  async getMRRStatCard({ dateFrom, dateTo }: DateRange): Promise<StatCard> {
    const { prevFrom, prevTo } = this.getPreviousPeriod(dateFrom, dateTo);

    const [currentAgg, previousAgg] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { status: 'successful', paymentDate: { gte: dateFrom, lte: dateTo } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { status: 'successful', paymentDate: { gte: prevFrom, lt: prevTo } },
        _sum: { amount: true },
      }),
    ]);

    const current  = Number(currentAgg._sum.amount ?? 0);
    const previous = Number(previousAgg._sum.amount ?? 0);

    return { total: current, percentageChangeFromLastMonth: this.percentageChange(current, previous) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WORKSPACE GROWTH PANEL
  //
  // webhookSuccessRate — % of PROCESSED webhooks out of all non-IGNORED
  //   Formula: (PROCESSED / (PROCESSED + FAILED + PENDING)) * 100
  //   Scope: within the selected date range using WebhookLog.createdAt
  //
  // connectedAccounts  — total active social profiles across all platforms
  //   (isActive = true, no date filter — reflects current live state)
  // ─────────────────────────────────────────────────────────────────────────

  async getWorkspaceGrowth({ dateFrom, dateTo }: DateRange): Promise<WorkspaceGrowth> {
    const [processed, failed, pending, connectedAccounts] = await Promise.all([
      // Successfully handled webhooks
      this.prisma.webhookLog.count({
        where: {
          status: 'PROCESSED',
          createdAt: { gte: dateFrom, lte: dateTo },
        },
      }),

      // Failed webhooks
      this.prisma.webhookLog.count({
        where: {
          status: 'FAILED',
          createdAt: { gte: dateFrom, lte: dateTo },
        },
      }),

      // Pending webhooks (not yet processed — still in queue)
      this.prisma.webhookLog.count({
        where: {
          status: 'PENDING',
          createdAt: { gte: dateFrom, lte: dateTo },
        },
      }),

      // Connected Accounts — all active social profiles (live state, no date filter)
      this.prisma.socialProfile.count({
        where: { isActive: true },
      }),
    ]);

    // Total excludes IGNORED webhooks — they are intentional no-ops, not failures
    const total = processed + failed + pending;

    const webhookSuccessRate =
      total === 0
        ? 100 // no webhooks = nothing failed
        : parseFloat(((processed / total) * 100).toFixed(1));

    return {
      webhookSuccessRate,
      webhookTotal: total,
      webhookProcessed: processed,
      webhookFailed: failed,
      // connectedAccounts,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CHART — "Users Growth" bar chart
  // ─────────────────────────────────────────────────────────────────────────

  async getUsersGrowthByMonth({ dateFrom, dateTo }: DateRange): Promise<MonthlyPoint[]> {
    const windows = this.getMonthWindows(dateFrom, dateTo);

    const counts = await Promise.all(
      windows.map(({ from, to }) =>
        this.prisma.user.count({
          where: { deletedAt: null, createdAt: { gte: from, lt: to } },
        }),
      ),
    );

    return windows.map(({ from }, idx) => ({
      month: MONTHS[from.getMonth()],
      year: from.getFullYear(),
      count: counts[idx],
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CHART — "Monthly Revenue" bar chart
  // ─────────────────────────────────────────────────────────────────────────

  async getMonthlyRevenueByMonth({ dateFrom, dateTo }: DateRange): Promise<MonthlyPoint[]> {
    const windows = this.getMonthWindows(dateFrom, dateTo);

    const results = await Promise.all(
      windows.map(({ from, to }) =>
        this.prisma.transaction.aggregate({
          where: { status: 'successful', paymentDate: { gte: from, lt: to } },
          _sum: { amount: true },
        }),
      ),
    );

    return windows.map(({ from }, idx) => ({
      month: MONTHS[from.getMonth()],
      year: from.getFullYear(),
      count: Number(results[idx]._sum.amount ?? 0),
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INFRASTRUCTURE HEALTH — always reflects current live state, no date filter
  // ─────────────────────────────────────────────────────────────────────────

  async getInfrastructureHealth(): Promise<InfrastructureHealth> {
    const [totalWorkspaces, queuedPosts, sentToday, failedJobs] = await Promise.all([
      this.prisma.workspace.count(),
      this.prisma.post.count({ where: { status: 'SCHEDULED' } }),
      this.prisma.post.count({
        where: { status: 'PUBLISHED', publishedAt: { gte: this.todayStart, lt: this.tomorrowStart } },
      }),
      this.prisma.post.count({ where: { status: 'FAILED' } }),
    ]);

    return { totalWorkspaces, queuedPosts, sentToday, failedJobs };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DONUT — "User Distribution" — always reflects current state, no date filter
  // ─────────────────────────────────────────────────────────────────────────

  async getUserDistribution(): Promise<UserDistributionResult> {
    const now           = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [total, active, suspended] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null, isEmailVerified: true, lastActiveAt: { gte: thirtyDaysAgo } } }),
      this.prisma.user.count({ where: { deletedAt: null, lockedUntil: { gte: now } } }),
    ]);

    return { active, suspended, inactive: Math.max(0, total - active - suspended) };
  }
}