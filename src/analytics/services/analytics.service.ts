import { PrismaService } from "@/prisma/prisma.service";
import { Injectable } from "@nestjs/common";

  @Injectable()
  export class AnalyticsService {
  constructor(private prisma: PrismaService) {}
  async getOrganizationStats(orgId: string, userId: string) {
    //await this.verifyMembership(orgId, userId);

    const stats = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        _count: {
          select: {
            members: { where: { isActive: true } },
            posts: true,
            aiContentGenerations: true,
            aiImageGenerations: true,
          },
        },
        posts: {
          select: {
            snapShots: {
              select: {
                likes: true,
                comments: true,
                shares: true,
                impressions: true,
              },
            },
          },
        },
      },
    });

    const totalEngagement = stats.posts.reduce((sum, post) => {
      const postEngagement = post.snapShots.reduce(
        (acc, a) => acc + (a.likes + a.comments + a.shares),
        0,
      );
      return sum + postEngagement;
    }, 0);

    const totalImpressions = stats.posts.reduce((sum, post) => {
      const postImpressions = post.snapShots.reduce(
        (acc, a) => acc + a.impressions,
        0,
      );
      return sum + postImpressions;
    }, 0);

    const engagementRate =
      totalImpressions > 0 ? (totalEngagement / totalImpressions) * 100 : 0;

    return {
      totalPosts: stats._count.posts,
      scheduledPosts: 0, // You'd need to track this separately
      aiGenerations:
        stats._count.aiContentGenerations + stats._count.aiImageGenerations,
      teamMembers: stats._count.members,
      engagementRate: parseFloat(engagementRate.toFixed(2)),
    };
  }
  }