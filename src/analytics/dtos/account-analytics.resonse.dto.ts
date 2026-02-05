import { ApiProperty } from "@nestjs/swagger";

class MetricAccessDto {
  @ApiProperty({ description: 'The actual value, or null if locked' })
  value: number | null;

  @ApiProperty({ description: 'If true, show a lock icon/upgrade tooltip' })
  isLocked: boolean;
}

export class AccountAnalyticsTieredResponseDto {
  @ApiProperty()
  period: { start: Date; end: Date };

  @ApiProperty()
  summary: {
    followersTotal: number;
    // These might be locked for Creator
    impressions: MetricAccessDto;
    reach: MetricAccessDto;
    engagementRate: MetricAccessDto;
    profileViews: MetricAccessDto;
    
    // Growth % (Business+)
    netGrowth: number; 
    growthPercentage: number | null; // Null for Creator
  };

  @ApiProperty({ required: false })
  demographics?: any; // Locked for Creator

  // Comparison Data (Business+)
  @ApiProperty({ required: false, description: 'Previous period data for comparison' })
  previousPeriodSummary?: any | null; 

  @ApiProperty({ type: 'array' })
  dailySeries: any[]; // The line chart data
}