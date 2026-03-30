import { ApiProperty } from '@nestjs/swagger';

class StatCardDto {
  @ApiProperty({ example: 2000 })
  total: number;

  @ApiProperty({
    example: 12.5,
    description:
      'Positive = growth, negative = decline vs equivalent previous period',
  })
  percentageChangeFromLastMonth: number;
}

class MonthlyPointDto {
  @ApiProperty({
    example: 'JUL',
    enum: [
      'JAN',
      'FEB',
      'MAR',
      'APR',
      'MAY',
      'JUN',
      'JUL',
      'AUG',
      'SEP',
      'OCT',
      'NOV',
      'DEC',
    ],
  })
  month: string;

  @ApiProperty({ example: 2025 })
  year: number;

  @ApiProperty({ example: 53 })
  count: number;
}

class UserDistributionDto {
  @ApiProperty({
    example: 1200,
    description: 'Verified users active in the last 30 days',
  })
  active: number;

  @ApiProperty({ example: 600, description: 'Verified but dormant > 30 days' })
  inactive: number;

  @ApiProperty({
    example: 200,
    description: 'Users with an active account lock',
  })
  suspended: number;
}

class InfrastructureHealthDto {
  @ApiProperty({ example: 12841 })
  totalWorkspaces: number;

  @ApiProperty({ example: 18203, description: 'Posts with status=SCHEDULED' })
  queuedPosts: number;

  @ApiProperty({ example: 9441, description: 'Posts published today' })
  sentToday: number;

  @ApiProperty({ example: 241, description: 'Posts with status=FAILED' })
  failedJobs: number;
}

class WorkspaceGrowthDto {
  @ApiProperty({
    example: 98.7,
    description:
      'Webhook success rate as a percentage. Formula: PROCESSED / (PROCESSED + FAILED + PENDING) * 100. IGNORED webhooks are excluded.',
  })
  webhookSuccessRate: number;

  @ApiProperty({
    example: 1560,
    description: 'Total non-IGNORED webhooks in the selected period',
  })
  webhookTotal: number;

  @ApiProperty({ example: 1540, description: 'Webhooks with status=PROCESSED' })
  webhookProcessed: number;

  @ApiProperty({ example: 20, description: 'Webhooks with status=FAILED' })
  webhookFailed: number;

  // @ApiProperty({ example: 84190, description: 'Total active social profiles across all platforms (isActive=true)' })
  // connectedAccounts: number;
}

export class DashboardAnalyticsDto {
  @ApiProperty({ type: StatCardDto })
  totalUsers: StatCardDto;

  @ApiProperty({ type: StatCardDto })
  totalWorkspaces: StatCardDto;

  @ApiProperty({ type: StatCardDto })
  connectedSocials: StatCardDto;

  @ApiProperty({ type: StatCardDto })
  monthlyRecurringRevenue: StatCardDto;

  @ApiProperty({
    type: [MonthlyPointDto],
    description: 'Users Growth bar chart',
  })
  usersGrowth: MonthlyPointDto[];

  @ApiProperty({
    type: [MonthlyPointDto],
    description: 'Monthly Revenue bar chart',
  })
  monthlyRevenue: MonthlyPointDto[];

  @ApiProperty({ type: UserDistributionDto })
  userDistribution: UserDistributionDto;

  @ApiProperty({ type: InfrastructureHealthDto })
  infrastructureHealth: InfrastructureHealthDto;

  @ApiProperty({
    type: WorkspaceGrowthDto,
    description:
      'Workspace Growth panel — webhook health and connected accounts',
  })
  workspaceGrowth: WorkspaceGrowthDto;
}
