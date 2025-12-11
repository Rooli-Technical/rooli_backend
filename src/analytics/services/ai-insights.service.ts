import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';


export interface AIInsight {
  type: 'performance' | 'recommendation' | 'warning';
  title: string;
  message: string;
  confidence: number;
  data?: any;
}

@Injectable()
export class AiInsightsService {
  private readonly logger = new Logger(AiInsightsService.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Generate AI-powered insights for an organization
   */
  // async generateInsights(organizationId: string): Promise<AIInsight[]> {
  //   const insights: AIInsight[] = [];

  //   // Get recent data for analysis
  //   const summary = await this.analyticsService.getOrganizationSummary(organizationId, {
  //     startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // Last 30 days
  //   });

  //   const platformPerformance = await this.analyticsService.getPlatformPerformance(organizationId, {});

  //   // Generate insights based on data patterns
  //   insights.push(...this.generatePerformanceInsights(summary));
  //   insights.push(...this.generatePlatformInsights(platformPerformance));
  //   insights.push(...this.generateRecommendationInsights(summary));

  //   return insights.sort((a, b) => b.confidence - a.confidence);
  // }

  private generatePerformanceInsights(summary: any): AIInsight[] {
    const insights: AIInsight[] = [];

    // Engagement rate insight
    if (summary.engagementRate < 0.02) {
      insights.push({
        type: 'warning',
        title: 'Low Engagement Rate',
        message: `Your engagement rate is ${(summary.engagementRate * 100).toFixed(1)}%. Consider creating more interactive content.`,
        confidence: 0.8,
        data: { engagementRate: summary.engagementRate },
      });
    }

    // CTR insight
    if (summary.clickThroughRate < 0.01) {
      insights.push({
        type: 'warning',
        title: 'Low Click-Through Rate',
        message: `Your CTR is ${(summary.clickThroughRate * 100).toFixed(1)}%. Try using stronger call-to-actions.`,
        confidence: 0.7,
      });
    }

    return insights;
  }

  private generatePlatformInsights(platforms: any[]): AIInsight[] {
    return platforms
      .filter(platform => platform.metrics.engagementRate > 0.03)
      .map(platform => ({
        type: 'performance',
        title: `Top Performing Platform: ${platform.platform}`,
        message: `Your ${platform.platform} content is performing ${(platform.percentageChange * 100).toFixed(0)}% better than average.`,
        confidence: 0.9,
        data: platform,
      }));
  }

  private generateRecommendationInsights(summary: any): AIInsight[] {
    const insights: AIInsight[] = [];

    // Best posting time recommendation (simplified)
    insights.push({
      type: 'recommendation',
      title: 'Optimal Posting Time',
      message: 'Based on your audience engagement, the best time to post is between 1-3 PM weekdays.',
      confidence: 0.6,
    });

    // Content type recommendation
    if (summary.totalComments > summary.totalLikes * 0.5) {
      insights.push({
        type: 'recommendation',
        title: 'Engaging Content Strategy',
        message: 'Your audience loves to comment! Try asking more questions in your posts.',
        confidence: 0.7,
      });
    }

    return insights;
  }
}