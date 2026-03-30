import { Injectable, BadRequestException } from '@nestjs/common';
import {
  AdminDashboardRepository,
  StatCard,
  MonthlyPoint,
  UserDistributionResult,
  InfrastructureHealth,
  WorkspaceGrowth,
  DateRange,
} from './admin-dashboard.repository';

export interface DashboardAnalytics {
  totalUsers: StatCard;
  totalWorkspaces: StatCard;
  connectedSocials: StatCard;
  monthlyRecurringRevenue: StatCard;
  usersGrowth: MonthlyPoint[];
  monthlyRevenue: MonthlyPoint[];
  userDistribution: UserDistributionResult;
  infrastructureHealth: InfrastructureHealth;
  workspaceGrowth: WorkspaceGrowth;
}

@Injectable()
export class AdminDashboardService {
  constructor(private readonly repository: AdminDashboardRepository) {}

  async getDashboardData(
    dateFrom?: string,
    dateTo?: string,
  ): Promise<DashboardAnalytics> {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultTo = now;

    const from = dateFrom ? new Date(dateFrom) : defaultFrom;
    const to = dateTo ? new Date(dateTo) : defaultTo;

    if (isNaN(from.getTime())) {
      throw new BadRequestException(
        'Invalid dateFrom. Use ISO 8601 format e.g. 2025-01-01',
      );
    }
    if (isNaN(to.getTime())) {
      throw new BadRequestException(
        'Invalid dateTo. Use ISO 8601 format e.g. 2025-06-30',
      );
    }
    if (from > to) {
      throw new BadRequestException('dateFrom must be before dateTo');
    }

    const range: DateRange = { dateFrom: from, dateTo: to };

    const [
      totalUsers,
      totalWorkspaces,
      connectedSocials,
      monthlyRecurringRevenue,
      usersGrowth,
      monthlyRevenue,
      userDistribution,
      infrastructureHealth,
      workspaceGrowth,
    ] = await Promise.all([
      this.repository.getTotalUsersStatCard(range),
      this.repository.getTotalWorkspacesStatCard(range),
      this.repository.getConnectedSocialsStatCard(range),
      this.repository.getMRRStatCard(range),
      this.repository.getUsersGrowthByMonth(range),
      this.repository.getMonthlyRevenueByMonth(range),
      this.repository.getUserDistribution(),
      this.repository.getInfrastructureHealth(),
      this.repository.getWorkspaceGrowth(range),
    ]);

    return {
      totalUsers,
      totalWorkspaces,
      connectedSocials,
      monthlyRecurringRevenue,
      usersGrowth,
      monthlyRevenue,
      userDistribution,
      infrastructureHealth,
      workspaceGrowth,
    };
  }
}
