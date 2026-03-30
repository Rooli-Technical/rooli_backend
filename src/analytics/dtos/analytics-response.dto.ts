import { ApiProperty } from '@nestjs/swagger';

class GrowthMetrics {
  @ApiProperty() followersTotal: number;
  @ApiProperty() followersGained: number;
  @ApiProperty() profileViews: number;
}

class EngagementMetrics {
  @ApiProperty() totalImpressions: number;
  @ApiProperty() totalEngagement: number; // Sum of likes+comments+shares
  @ApiProperty() engagementRate: number; // Calculated %
}

export class AnalyticsResponseDto {
  @ApiProperty({ type: GrowthMetrics })
  growth: GrowthMetrics;

  @ApiProperty({ type: EngagementMetrics })
  engagement: EngagementMetrics;

  @ApiProperty({ description: 'List of daily data points for charts' })
  dailyHistory: Array<{
    date: string;
    impressions: number;
    followers: number;
  }>;
}
