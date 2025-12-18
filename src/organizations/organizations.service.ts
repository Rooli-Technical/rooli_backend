import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateOrganizationDto } from './dtos/create-organization.dto';
import { UpdateOrganizationDto } from './dtos/update-organization.dto';
import { GetAllOrganizationsDto } from './dtos/get-organiations.dto';
import { PrismaService } from '@/prisma/prisma.service';
import slugify from 'slugify';
import dayjs from 'dayjs';
import { BillingService } from '@/billing/billing.service';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
  ) {}

  async createOrganization(userId: string, dto: CreateOrganizationDto) {
    try {
      if (dto.userType) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { userType: dto.userType },
        });
      }

      // 1. Fetch User and their owned organizations count in one go
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          organizationMemberships: {
            where: { role: { name: 'owner' } }, // Assuming 'Role' model has a 'name' field
          },
        },
      });

      if (!user) throw new NotFoundException('User not found');

      // 3. Guard: Enforce Individual Limits
      const ownedOrgCount = user.organizationMemberships.length;
      if (user.userType === 'INDIVIDUAL' && ownedOrgCount >= 1) {
        throw new ForbiddenException({
          message:
            'Individual accounts are limited to 1 Workspace. Please upgrade to Agency.',
        });
      }

      //  Prepare Slug
      // If dto.slug is provided, use it; otherwise generate from name
      const slug = slugify(dto.name, { lower: true, strict: true });

      //  Check Slug Uniqueness
      const existing = await this.prisma.organization.findUnique({
        where: { slug },
      });

      if (existing) {
        throw new ConflictException(
          'Organization URL (slug) is already taken. Please try another.',
        );
      }

      // Transaction: Create Org + Member + BrandKit
      const organization = await this.prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: {
            name: dto.name,
            slug,
            timezone: dto.timezone ?? 'UTC',
            email: dto.email ?? user.email,
            status: 'PENDING_PAYMENT',
            isActive: true,
          },
        });

        const ownerRole = await tx.role.findFirst({
          where: { name: 'owner' },
        });

        if (!ownerRole) {
          throw new InternalServerErrorException(
            "System Error: 'owner' role not found.",
          );
        }

        await tx.organizationMember.create({
          data: {
            organizationId: org.id,
            userId,
            roleId: ownerRole.id,
            invitedBy: userId,
          },
        });

        await tx.brandKit.create({
          data: {
            organizationId: org.id,
            name: `${dto.name} Brand Kit`,
          },
        });

        return org;
      });

      // 4. Initialize payment (OUTSIDE transaction)
      const paymentData = await this.billingService.initializePayment(
        organization.id,
        dto.planId,
        user,
      );

      // 5. Return combined response
      return {
        organization,
        payment: paymentData,
      };
    } catch (err) {
      // Log error for debugging but rethrow purely
      this.logger.error('Failed to create organization', err);
      throw err;
    }
  }

  async getOrganization(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId, isActive: true },
      include: {
        _count: {
          select: { members: true, posts: true },
        },
      },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async getAllOrganizations(dto: GetAllOrganizationsDto) {
    const { name, isActive, page, limit } = dto;

    // Calculate pagination offsets
    const skip = (page - 1) * limit;
    const take = limit;

    const where: any = {};

    if (name) where.name = { contains: name, mode: 'insensitive' };
    if (isActive !== undefined) where.isActive = isActive;

    const organizations = await this.prisma.organization.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    });

    return organizations;
  }

  async updateOrganization(orgId: string, dto: UpdateOrganizationDto) {
    return this.prisma.organization.update({
      where: { id: orgId },
      data: {
        ...dto,
        updatedAt: new Date(),
      },
    });
  }

  async deleteOrganization(orgId: string, userId: string) {
    // Soft delete organization and related data
    return this.prisma.$transaction(async (tx) => {
      // Deactivate organization
      await tx.organization.update({
        where: { id: orgId },
        data: { isActive: false, status: 'SUSPENDED' },
      });

      // Deactivate all members
      await tx.organizationMember.updateMany({
        where: { organizationId: orgId },
        data: { isActive: false },
      });

      // Cancel any active subscriptions
      //await this.cancelSubscription(orgId);

      return { success: true, message: 'Organization deleted successfully' };
    });
  }

  /**
   * Main Dashboard Analytics with Trend Comparisons (Current vs Previous Period)
   */
  async getAnalyticsOverview(orgId: string, days = 30) {
    const endDate = dayjs().endOf('day').toDate();
    const startDate = dayjs().subtract(days, 'days').startOf('day').toDate();

    const prevEndDate = dayjs(startDate).subtract(1, 'second').toDate();
    const prevStartDate = dayjs(startDate)
      .subtract(days, 'days')
      .startOf('day')
      .toDate();

    // 1. Run Aggregations in Parallel
    const [currentStats, prevStats, currentPosts, prevPosts] =
      await Promise.all([
        // A. Current Period Stats
        this.prisma.accountAnalytics.aggregate({
          where: {
            date: { gte: startDate, lte: endDate },
            socialAccount: { organizationId: orgId }, // Filter by Org via Relation
          },
          _sum: {
            reach: true,
            impressions: true,
            engagementCount: true,
            followersGained: true,
          },
          _max: { followersTotal: true },
        }),

        // B. Previous Period Stats (For Trend Calculation)
        this.prisma.accountAnalytics.aggregate({
          where: {
            date: { gte: prevStartDate, lte: prevEndDate },
            socialAccount: { organizationId: orgId },
          },
          _sum: {
            reach: true,
            impressions: true,
            engagementCount: true,
            followersGained: true,
          },
          _max: { followersTotal: true },
        }),

        // C. Post Counts
        this.prisma.post.count({
          where: {
            organizationId: orgId,
            status: 'PUBLISHED',
            publishedAt: { gte: startDate, lte: endDate },
          },
        }),
        this.prisma.post.count({
          where: {
            organizationId: orgId,
            status: 'PUBLISHED',
            publishedAt: { gte: prevStartDate, lte: prevEndDate },
          },
        }),
      ]);

    // 2. Calculate Trends
    const calcTrend = (curr: number, prev: number) => {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return parseFloat((((curr - prev) / prev) * 100).toFixed(1));
    };

    const currentReach = currentStats._sum.reach || 0;
    const prevReach = prevStats._sum.reach || 0;

    const currentEng = currentStats._sum.engagementCount || 0;
    const prevEng = prevStats._sum.engagementCount || 0;

    const currentImp = currentStats._sum.impressions || 0;
    // Engagement Rate = (Engagement / Impressions) * 100
    const engagementRate = currentImp > 0 ? (currentEng / currentImp) * 100 : 0;

    return {
      overview: {
        posts: {
          value: currentPosts,
          trend: calcTrend(currentPosts, prevPosts),
        },
        reach: {
          value: currentReach,
          trend: calcTrend(currentReach, prevReach),
        },
        engagement: {
          value: currentEng,
          trend: calcTrend(currentEng, prevEng),
          rate: parseFloat(engagementRate.toFixed(2)), // e.g. 4.5%
        },
        followers: {
          // Approximate total by taking max from current period (requires more complex logic for exacts across multiple accounts)
          total: currentStats._max.followersTotal || 0,
          gained: currentStats._sum.followersGained || 0,
        },
      },
    };
  }

  async getDashboardAggregates(organizationId: string) {
    const now = dayjs();
    const startOfWeek = now.startOf('week').toDate();
    const endOfWeek = now.endOf('week').toDate();
    const startOfMonth = now.startOf('month').toDate();
    const endOfMonth = now.endOf('month').toDate();

    const [draftsWeek, scheduledWeek, publishedMonth, socialCount, pageCount] =
      await Promise.all([
        this.prisma.post.count({
          where: {
            organizationId,
            status: 'DRAFT',
            updatedAt: { gte: startOfWeek, lte: endOfWeek },
          },
        }),
        this.prisma.post.count({
          where: {
            organizationId,
            status: 'SCHEDULED',
            scheduledAt: { gte: startOfWeek, lte: endOfWeek },
          },
        }),
        this.prisma.post.count({
          where: {
            organizationId,
            status: 'PUBLISHED',
            publishedAt: { gte: startOfMonth, lte: endOfMonth },
          },
        }),
        this.prisma.socialAccount.count({
          where: { organizationId, isActive: true },
        }),
        this.prisma.pageAccount.count({
          where: { socialAccount: { organizationId }, isActive: true },
        }),
      ]);

    return {
      metrics: {
        draftsThisWeek: draftsWeek,
        scheduledThisWeek: scheduledWeek,
        publishedThisMonth: publishedMonth,
        connectedChannels: socialCount + pageCount,
      },
    };
  }

  async getOrganizationMediaUsage(organizationId: string) {
    const [fileStats, folderCount, templateCount] = await Promise.all([
      this.prisma.mediaFile.aggregate({
        where: { organizationId },
        _sum: { size: true },
        _count: { _all: true },
      }),
      this.prisma.mediaFolder.count({ where: { organizationId } }),
      this.prisma.contentTemplate.count({ where: { organizationId } }),
    ]);

    const totalBytes = Number(fileStats._sum.size || 0);

    return {
      fileCount: fileStats._count._all,
      folderCount,
      templateCount,
      usedStorage: this.formatBytes(totalBytes),
      rawBytes: totalBytes,
    };
  }

  async getTopPerformingPosts(organizationId: string, limit = 5) {
    // Optimization: Only fetch last 90 days to avoid sorting thousands of records in memory
    const posts = await this.prisma.post.findMany({
      where: {
        organizationId,
        status: 'PUBLISHED',
        publishedAt: { gte: dayjs().subtract(90, 'days').toDate() },
      },
      select: {
        id: true,
        content: true,
        publishedAt: true,
        socialAccount: { select: { platform: true, username: true } },
        snapShots: {
          take: 1,
          orderBy: { recordedAt: 'desc' }, // Get latest stats
          select: {
            likes: true,
            comments: true,
            shares: true,
            impressions: true,
          },
        },
      },
    });

    // Calculate Engagement Score in Memory
    // Score = Likes + Comments + (Shares * 2)
    const scoredPosts = posts.map((post) => {
      const stats = post.snapShots[0] || {
        likes: 0,
        comments: 0,
        shares: 0,
        impressions: 0,
      };
      const score = stats.likes + stats.comments + stats.shares * 2;
      return { ...post, stats, engagementScore: score };
    });

    // Sort descending and slice
    return scoredPosts
      .sort((a, b) => b.engagementScore - a.engagementScore)
      .slice(0, limit);
  }

  async getRecentActivity(organizationId: string) {
    const [files, posts] = await Promise.all([
      this.prisma.mediaFile.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.post.findMany({
        where: { organizationId, status: { not: 'DRAFT' } },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        include: { author: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    return { recentFiles: files, recentPosts: posts };
  }

  // Helper
  private formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
  }
}
