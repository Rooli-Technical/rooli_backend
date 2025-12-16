import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateOrganizationDto } from './dtos/create-organization.dto';
import { UpdateOrganizationDto } from './dtos/update-organization.dto';
import { OrganizationUsageDto } from './dtos/organization-usage.dto';
import { GetAllOrganizationsDto } from './dtos/get-organiations.dto';
import { PrismaService } from '@/prisma/prisma.service';
import slugify from 'slugify';
import dayjs from 'dayjs';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrganization(userId: string, dto: CreateOrganizationDto) {
    try {
      const ownedMemberships = await this.prisma.organizationMember.findMany({
        where: {
          userId: userId,
          role: { name: 'OWNER' }, // Only count orgs they OWN, not ones they were invited to
        },
        include: { organization: true },
      });
      const ownedCount = ownedMemberships.length;
      if (ownedCount >= 1) {
        // They already have a workspace. Check if they are allowed another.

        // Check if ANY of their owned orgs is an AGENCY tier
        // (Or checking the specific "Billing" org if you separate them)
        const hasAgencyPlan = ownedMemberships.some(
          (m) => m.organization.planTier === 'AGENCY',
        );

        if (!hasAgencyPlan) {
          throw new ForbiddenException(
            'You are on the FREE plan. You can only manage 1 Workspace. Upgrade to Agency to create more.',
          );
        }
      }
      const slug = slugify(dto.name, { lower: true, strict: true });

      // Check if slug is available
      const existing = await this.prisma.organization.findUnique({
        where: { slug },
      });

      if (existing) {
        throw new ConflictException('Organization slug already exists');
      }

      // Create organization and make user the owner
      return await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: {
            name: dto.name,
            slug: dto.slug,
            timezone: dto.timezone || 'UTC',
            email: dto.email,
            planTier: 'FREE',
            planStatus: 'ACTIVE',
            maxMembers: 5, // Default limit
            monthlyCreditLimit: 1000, // Default credits
          },
        });

        const ownerRole = await tx.role.findFirst({
          where: { name: 'owner' },
        });

        if (!ownerRole) {
          throw new NotFoundException(
            "Role 'owner' does not exist. Seed your roles table first.",
          );
        }

        // Add user as owner
        await tx.organizationMember.create({
          data: {
            organizationId: organization.id,
            userId: userId,
            roleId: ownerRole.id,
            invitedBy: userId,
          },
        });

        // Create default brand kit
        await tx.brandKit.create({
          data: {
            organizationId: organization.id,
            name: 'Our Brand',
          },
        });

        return organization;
      });
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  async getOrganization(orgId: string) {
    const membership = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: orgId,
        isActive: true,
      },
      include: {
        organization: {
          include: {
            _count: {
              select: {
                members: { where: { isActive: true } },
                posts: true,
                aiContentGenerations: true,
                aiImageGenerations: true,
              },
            },
          },
        },
      },
    });

    if (!membership) {
      throw new NotFoundException('Organization not found or access denied');
    }

    return membership.organization;
  }

  async getAllOrganizations(dto: GetAllOrganizationsDto) {
    const { name, isActive, planTier, planStatus, page, limit } = dto;

    // Calculate pagination offsets
    const skip = (page - 1) * limit;
    const take = limit;

    const where: any = {};

    if (name) where.name = { contains: name, mode: 'insensitive' };
    if (isActive !== undefined) where.isActive = isActive;
    if (planTier) where.planTier = planTier;
    if (planStatus) where.planStatus = planStatus;

    const organizations = await this.prisma.organization.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    });

    return organizations;
  }

  async updateOrganization(
    orgId: string,
    userId: string,
    dto: UpdateOrganizationDto,
  ) {
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
        data: { isActive: false },
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

  async getOrganizationUsage(orgId: string): Promise<OrganizationUsageDto> {
    // Validation
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { maxMembers: true, monthlyCreditLimit: true },
    });
    if (!org) throw new NotFoundException('Organization not found');

    // 2. Parallel Count Queries
    const [memberCount, creditUsage, postCount, mediaStorage] =
      await Promise.all([
        this.prisma.organizationMember.count({
          where: { organizationId: orgId, isActive: true },
        }),
        // Sum of tokens
        this.prisma.aIUsage.aggregate({
          where: { organizationId: orgId },
          _sum: { tokensUsed: true },
        }),
        // Count posts
        this.prisma.post.count({ where: { organizationId: orgId } }),
        // Sum file size (Storage usage)
        this.prisma.mediaFile.aggregate({
          where: { organizationId: orgId },
          _sum: { size: true },
        }),
      ]);

    return {
      memberCount,
      creditUsage: creditUsage._sum.tokensUsed || 0,
      postCount,
      mediaStorage: mediaStorage._sum.size ? Number(mediaStorage._sum.size) : 0,
      maxMembers: org.maxMembers,
      monthlyCreditLimit: org.monthlyCreditLimit,
    };
  }

  // async getDashboard(orgId: string, daysCount: number = 30) {
  //   const today = new Date();
  //   today.setHours(23, 59, 59, 999);

  //   const currentStart = new Date();
  //   currentStart.setDate(today.getDate() - daysCount);
  //   currentStart.setHours(0, 0, 0, 0);

  //   const previousStart = new Date(currentStart);
  //   previousStart.setDate(previousStart.getDate() - daysCount);

  //   const orgFilter = {
  //     OR: [
  //       { socialAccount: { organizationId: orgId } },
  //       { pageAccount: { socialAccount: { organizationId: orgId } } },
  //     ],
  //   };

  //   // Use labeled promises for clearer reading
  //   const queries = {
  //     currentFlow: this.prisma.accountAnalyticsDaily.aggregate({
  //       _sum: {
  //         reach: true,
  //         impressions: true,
  //         engagementCount: true,
  //         followersGained: true,
  //       },
  //       where: { date: { gte: currentStart, lte: today }, ...orgFilter },
  //     }),
  //     prevFlow: this.prisma.accountAnalyticsDaily.aggregate({
  //       _sum: { reach: true, impressions: true, engagementCount: true },
  //       where: { date: { gte: previousStart, lt: currentStart }, ...orgFilter },
  //     }),
  //     currentMaxFollowers: this.prisma.accountAnalyticsDaily.groupBy({
  //       by: ['socialAccountId', 'pageAccountId'],
  //       _max: { followersTotal: true },
  //       where: { date: { gte: currentStart, lte: today }, ...orgFilter },
  //     }),
  //     prevMaxFollowers: this.prisma.accountAnalyticsDaily.groupBy({
  //       by: ['socialAccountId', 'pageAccountId'],
  //       _max: { followersTotal: true },
  //       where: { date: { gte: previousStart, lt: currentStart }, ...orgFilter },
  //     }),
  //     currentPosts: this.prisma.post.count({
  //       where: {
  //         organizationId: orgId,
  //         status: 'PUBLISHED',
  //         publishedAt: { gte: currentStart, lte: today },
  //       },
  //     }),
  //     prevPosts: this.prisma.post.count({
  //       where: {
  //         organizationId: orgId,
  //         status: 'PUBLISHED',
  //         publishedAt: { gte: previousStart, lt: currentStart },
  //       },
  //     }),
  //     recentPosts: this.prisma.post.findMany({
  //       where: { organizationId: orgId, status: 'PUBLISHED' },
  //       orderBy: { publishedAt: 'desc' }, // Newest first
  //       take: 5,
  //       select: {
  //         id: true,
  //         content: true,
  //         platform: true,
  //         publishedAt: true,
  //         snapShots: {
  //           take: 1,
  //           orderBy: { recordedAt: 'desc' },
  //           select: {
  //             likes: true,
  //             comments: true,
  //             shares: true,
  //             impressions: true,
  //           },
  //         },
  //       },
  //     }),

  //     // --- H. UPCOMING SCHEDULED POSTS ---
  //     scheduledPosts: this.prisma.post.findMany({
  //       where: { organizationId: orgId, status: 'SCHEDULED' },
  //       orderBy: { scheduledAt: 'asc' }, // Soonest first
  //       take: 5,
  //       select: {
  //         id: true,
  //         content: true,
  //         platform: true,
  //         scheduledAt: true,
  //       },
  //     }),
  //   };

  //   // Execute Parallel
  //   const results = await Promise.all(Object.values(queries));

  //   // Map results back to keys
  //   const data = {
  //     currentFlow: results[0] as any,
  //     prevFlow: results[1] as any,
  //     currentMaxFollowers: results[2] as any[],
  //     prevMaxFollowers: results[3] as any[],
  //     currentPosts: results[4] as number,
  //     prevPosts: results[5] as number,
  //     recentPosts: results[6] as any[],
  //     scheduledPosts: results[7] as any[],
  //   };

  //   // Calculations
  //   const totalFollowersNow = data.currentMaxFollowers.reduce(
  //     (sum, item) => sum + (item._max.followersTotal || 0),
  //     0,
  //   );
  //   const totalFollowersPrev = data.prevMaxFollowers.reduce(
  //     (sum, item) => sum + (item._max.followersTotal || 0),
  //     0,
  //   );

  //   const currentEng = data.currentFlow._sum.engagementCount || 0;
  //   const currentImp = data.currentFlow._sum.impressions || 0;
  //   // Avoid division by zero
  //   const engagementRate =
  //     currentImp > 0 ? ((currentEng / currentImp) * 100).toFixed(2) : 0;

  //   const recentPostsFormatted = data.recentPosts.map((post) => {
  //     const stats = post.snapShots[0] || {
  //       likes: 0,
  //       comments: 0,
  //       shares: 0,
  //       impressions: 0,
  //     };
  //     return {
  //       id: post.id,
  //       platform: post.platform,
  //       content: post.content,
  //       publishedAt: post.publishedAt,
  //       thumbnail: post.mediaFiles[0]?.url || null,
  //       metrics: {
  //         likes: stats.likes,
  //         comments: stats.comments,
  //         shares: stats.shares,
  //         impressions: stats.impressions,
  //       },
  //     };
  //   });

  //   const scheduledPostsFormatted = data.scheduledPosts.map((post) => ({
  //     id: post.id,
  //     platform: post.platform,
  //     content: post.content,
  //     scheduledAt: post.scheduledAt,
  //   }));

  //   return {
  //     posts: {
  //       total: data.currentPosts,
  //       trend: this.calculateTrend(data.currentPosts, data.prevPosts),
  //       label: 'posts published',
  //     },
  //     followers: {
  //       total: totalFollowersNow,
  //       gained: data.currentFlow._sum.followersGained || 0,
  //       trend: this.calculateTrend(totalFollowersNow, totalFollowersPrev),
  //     },
  //     reach: {
  //       value: data.currentFlow._sum.reach || 0,
  //       trend: this.calculateTrend(
  //         data.currentFlow._sum.reach || 0,
  //         data.prevFlow._sum.reach || 0,
  //       ),
  //     },
  //     engagement: {
  //       total: currentEng,
  //       rate: engagementRate,
  //       trend: this.calculateTrend(
  //         currentEng,
  //         data.prevFlow._sum.engagementCount || 0,
  //       ),
  //     },
  //     widgets: {
  //       recent_posts: recentPostsFormatted,
  //       scheduled_posts: scheduledPostsFormatted,
  //     },
  //   };
  // }

  private calculateTrend(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return parseFloat((((current - previous) / previous) * 100).toFixed(1));
  }

  async getLatestPosts(organizationId: string) {
    return await this.prisma.post.findMany({
      where: {
        organizationId: organizationId,
      },
      take: 10, // Limit to 10
      orderBy: {
        updatedAt: 'desc', // Shows the most recently worked-on posts first
      },
      include: {
        socialAccount: {
          select: {
            platform: true,
            username: true,
            //profilePictureUrl: true, // Useful for UI icons
          },
        },
        pageAccount: {
          // In case it's a Page post
          select: {
            name: true,
            platformPageId: true,
          },
        },
        author: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        snapShots: {
          select: {
            likes: true,
            comments: true,
            impressions: true,
          },
        },
      },
    });
  }

async getDashboardAggregates(organizationId: string) {
    const now = dayjs();
    
    const startOfWeek = now.startOf('week').toDate(); 
    const endOfWeek = now.endOf('week').toDate();

    // Start of Month to End of Month
    const startOfMonth = now.startOf('month').toDate();
    const endOfMonth = now.endOf('month').toDate();

    // 2. Execute Queries in Parallel
    const [
        draftsWeek, 
        scheduledWeek, 
        publishedMonth, 
        socialAccountsCount, 
        pageAccountsCount
    ] = await Promise.all([
      
      // A. Drafts (This Week) - Based on activity (updatedAt)
      this.prisma.post.count({
        where: {
          organizationId,
          status: 'DRAFT',
          updatedAt: { gte: startOfWeek, lte: endOfWeek },
        },
      }),

      // B. Scheduled (This Week)
      this.prisma.post.count({
        where: {
          organizationId,
          status: 'SCHEDULED',
          scheduledAt: { gte: startOfWeek, lte: endOfWeek },
        },
      }),

      // C. Scheduled (This Month)
      this.prisma.post.count({
        where: {
          organizationId,
          status: 'PUBLISHED',
          scheduledAt: { gte: startOfMonth, lte: endOfMonth },
        },
      }),

      // D. Connected Social Accounts (Profiles)
      // Uses your direct organizationId field
      this.prisma.socialAccount.count({
        where: {
          organizationId: organizationId,
          isActive: true,
        },
      }),

      // E. Connected Page Accounts (Business Pages)
      // Pages belong to a Social Account, so we filter by the parent SocialAccount's Org ID
      this.prisma.pageAccount.count({
        where: {
          socialAccount: {
            organizationId: organizationId,
          },
        },
      }),
    ]);

    // 3. Return Clean JSON
    return {
      metrics: {
        draftsThisWeek: draftsWeek,
        scheduledThisWeek: scheduledWeek,
        scheduledThisMonth: publishedMonth,
        // The total number of "Channels" the user can post to
        totalConnectedPlatforms: socialAccountsCount + pageAccountsCount,
      },
      meta: {
        weekRange: { start: startOfWeek, end: endOfWeek },
        monthRange: { start: startOfMonth, end: endOfMonth },
      }
    };
  }

  /**
   * Get organization storage stats
   */
  async getOrganizationMediaUsage(organizationId: string) {
    const [fileStats, folderCount, templateCount] = await Promise.all([
      // 1. Aggregate files: Count IDs and Sum Size
      this.prisma.mediaFile.aggregate({
        where: { organizationId },
        _sum: { size: true },
        _count: { _all: true },
      }),
      // 2. Count folders
      this.prisma.mediaFolder.count({
        where: { organizationId },
      }),
      this.prisma.contentTemplate.count({
        where: { organizationId },
      }),
    ]);

    const totalBytes = fileStats._sum.size ? Number(fileStats._sum.size) : 0;


    return {
      fileCount: fileStats._count._all,
      folderCount: folderCount,
      templateCount: templateCount,
      totalSizeBytes: totalBytes,
      formattedSize: this.formatBytes(totalBytes), 
    };
  }

  // Helper function for human-readable sizes
  private formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  async getDashboardRecentActivity(organizationId: string) {
    const [recentFiles, recentTemplates, recentFolders] = await Promise.all([
      // 1. Fetch Latest Media Files
      this.prisma.mediaFile.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          filename: true,
          originalName: true,
          url: true,
          thumbnailUrl: true,
          mimeType: true,
          size: true,
          createdAt: true,
          updatedAt: true,
        },
      }),

      // 2. Fetch Latest Templates
      this.prisma.contentTemplate.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          name: true,
          category: true,
          platform: true,
          status: true,
          updatedAt: true,
        },
      }),

      // 3. Fetch Latest Folders + Count of files inside (Interpreting "assets in each file/folder")
      this.prisma.mediaFolder.findMany({
        where: { organizationId },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        include: {
          _count: {
            select: { files: true },
          },
        },
      }),
    ]);

    // --- Data Transformation ---

    const formattedFiles = recentFiles.map((file) => ({
      ...file,
      mediaType: file.mimeType.startsWith('video/') ? 'video' : 'image',
      formattedSize: this.formatBytes(Number(file.size)),
    }));

    const formattedFolders = recentFolders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      createdAt: folder.createdAt,
      assetCount: folder._count.files,
    }));

    return {
      latestFiles: formattedFiles,
      latestTemplates: recentTemplates,
      latestFolders: formattedFolders,
    };
  }

  async getTopPerformingPosts(organizationId: string, limit = 5) {
    // 1. Fetch Published Posts
    // optimization: We restrict to posts from the last 90 days to keep the query fast.
    // If you want "All Time" best, remove the 'publishedAt' filter.
    const posts = await this.prisma.post.findMany({
      where: {
        organizationId,
        status: 'PUBLISHED',
        publishedAt: {
          gte: dayjs().subtract(90, 'days').toDate(), // Last 3 months
        },
      },
      select: {
        id: true,
        content: true,
        publishedAt: true,
        mediaFileIds: true, // For image thumbnails
        socialAccount: {
          select: {
            platform: true,
            username: true,
          },
        },
        // 2. Fetch ONLY the most recent snapshot for each post
        // The latest snapshot contains the current total likes/comments
        snapShots: {
          take: 1,
          orderBy: { recordedAt: 'desc' },
          select: {
            likes: true,
            comments: true,
            shares: true,
            impressions: true,
          },
        },
      },
    });

    // 3. Calculate Score & Sort in Memory
    const sortedPosts = posts
      .map((post) => {
        // Handle cases where a post might not have a snapshot yet
        const stats = post.snapShots[0] || { likes: 0, comments: 0, shares: 0, impressions: 0 };
        
        // Weighted Score Formula:
        // You can tweak this! e.g., Shares might be worth 2x Points.
        // Current: Simple Sum (Likes + Comments + Shares)
        const engagementScore = stats.likes + stats.comments + stats.shares;

        return {
          ...post,
          stats, // Pass the clean stats object to frontend
          engagementScore,
        };
      })
      .sort((a, b) => b.engagementScore - a.engagementScore) // Sort Highest to Lowest
      .slice(0, limit); // Take top 5 (or 10)

    return sortedPosts;
  }

  async checkMemberLimit(orgId: string): Promise<boolean> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { maxMembers: true },
    });

    const memberCount = await this.prisma.organizationMember.count({
      where: { organizationId: orgId, isActive: true },
    });

    return memberCount < organization.maxMembers;
  }

  // private async verifyOwnership(orgId: string, userId: string) {
  //   let ownerRole = await this.prisma.role.findUnique({
  //     where: { name: 'OWNER' },
  //   });

  //   const membership = await this.prisma.organizationMember.findFirst({
  //     where: {
  //       organizationId: orgId,
  //       userId: userId,
  //       roleId: ownerRole.id,
  //       isActive: true,
  //     },
  //   });

  //   if (!membership) {
  //     throw new ForbiddenException(
  //       'Only organization owners can perform this action',
  //     );
  //   }
  // }

  private async verifyMembership(orgId: string, userId: string) {
    const membership = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: orgId,
        userId: userId,
        isActive: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('Organization access denied');
    }
  }

  private async cancelSubscription(orgId: string) {
    // Integrate with your billing service (Stripe, etc.)
    // This is a placeholder implementation
    console.log(`Canceling subscription for organization ${orgId}`);
  }
}
