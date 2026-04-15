import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCampaignDto } from './dto/request/create-campaign.dto';
import { UpdateCampaignDto } from './dto/request/update-campaign.dto';
import { PublishStatus } from '@generated/enums';

@Injectable()
export class CampaignService {
  constructor(private readonly prisma: PrismaService) {}

  async create(workspaceId: string, dto: CreateCampaignDto) {
    if (dto.startDate && dto.endDate) {
      if (new Date(dto.endDate) < new Date(dto.startDate)) {
        throw new BadRequestException('End date cannot be before start date');
      }
    }

    const existing = await this.prisma.campaign.findFirst({
      where: { workspaceId, name: dto.name },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('Campaign name already exists');

    return this.prisma.campaign.create({
      data: {
        workspaceId,
        name: dto.name.trim(),
        description: dto.description?.trim(),
        color: dto.color ?? '#1877F2',
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        status: 'ACTIVE',
      },
    });
  }

  async update(
    workspaceId: string,
    campaignId: string,
    dto: UpdateCampaignDto,
  ) {
    const campaign = await this.get(workspaceId, campaignId);

    const newStart = dto.startDate
      ? new Date(dto.startDate)
      : campaign.startDate;
    const newEnd =
      dto.endDate !== undefined
        ? dto.endDate
          ? new Date(dto.endDate)
          : null
        : campaign.endDate;

    if (newEnd && newStart && newEnd < newStart) {
      throw new BadRequestException('End date cannot be before start date');
    }

    if (dto.name && dto.name !== campaign.name) {
      const existing = await this.prisma.campaign.findFirst({
        where: { workspaceId, name: dto.name, NOT: { id: campaignId } },
        select: { id: true },
      });
      if (existing)
        throw new BadRequestException('Campaign name already exists');
    }

    return this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        name: dto.name?.trim(),
        description: dto.description,
        color: dto.color,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate
          ? new Date(dto.endDate)
          : dto.endDate === null
            ? null
            : undefined,
        status: dto.status,
      },
    });
  }

  async getCampaignAnalytics(workspaceId: string, campaignId: string) {
    // 1. Validate / Fetch Campaign
    await this.get(workspaceId, campaignId);

    // 2. Fetch Hierarchy (Now including the split tables!)
    const posts = await this.prisma.post.findMany({
      where: {
        workspaceId,
        campaignId,
        destinations: { some: { status: 'SUCCESS' } },
      },
      include: {
        destinations: {
          where: { status: 'SUCCESS' },
          include: {
            // We need the platform to know which stats table to check
            profile: { select: { platform: true } },
            postAnalyticsSnapshots: {
              orderBy: { day: 'desc' }, // 'day' is usually better than fetchedAt for snapshots
              take: 1,
              // Bring in our new specific tables!
              include: {
                twitterStats: true,
                linkedInStats: true,
                facebookStats: true,
                instagramStats: true,
                tiktokStats: true,
              },
            },
          },
        },
      },
    });

    // 3. Initialize Stats
    const stats = {
      totalPosts: posts.length,
      totalImpressions: 0,
      totalReach: 0,
      totalLikes: 0,
      totalComments: 0,
      totalShares: 0,
      totalClicks: 0,
      totalEngagements: 0,
    };

    // 4. Aggregation
    for (const post of posts) {
      for (const dest of post.destinations) {
        const snapshot = dest.postAnalyticsSnapshots[0];
        const platform = dest.profile.platform;

        if (snapshot) {
          // --- THE UNIFIED CORE ---
          stats.totalImpressions += snapshot.impressions || 0;
          stats.totalReach += snapshot.reach || 0;
          stats.totalLikes += snapshot.likes || 0;
          stats.totalComments += snapshot.comments || 0;

          // We can just use our pre-calculated engagement count from the base table!
          stats.totalEngagements += snapshot.engagementCount || 0;

          // --- THE PLATFORM SPECIFICS ---
          // We have to route shares and clicks based on the platform's unique terminology
          switch (platform) {
            case 'TWITTER':
              stats.totalShares += snapshot.twitterStats?.retweets || 0;
              stats.totalShares += snapshot.twitterStats?.quotes || 0;
              // Twitter doesn't return clicks reliably without premium API, so we skip or add if you have it
              break;

            case 'LINKEDIN':
              stats.totalShares += snapshot.linkedInStats?.reposts || 0;
              stats.totalClicks += snapshot.linkedInStats?.clicks || 0;
              break;

            case 'FACEBOOK':
              stats.totalShares += snapshot.facebookStats?.shares || 0;
              stats.totalClicks += snapshot.facebookStats?.linkClicks || 0;
              break;

            case 'INSTAGRAM':
              stats.totalShares += snapshot.instagramStats?.shares || 0;
              // IG doesn't have link clicks on regular feed posts usually, but you can map it if needed
              break;
            case 'TIKTOK':
              stats.totalShares += snapshot.tiktokStats?.shares || 0;
              stats.totalClicks += snapshot.tiktokStats?.videoViews || 0;
              break;
          }
        }
      }
    }

    return stats;
  }

  async get(workspaceId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id: campaignId,
        workspaceId,
      },
      include: {
        posts: {
          include: {
            media: {
              select: {
                mediaFile: {
                  select: {
                    url: true,
                    mimeType: true,
                  },
                },
              },
            },
            destinations: {
              include: {
                profile: {
                  select: {
                    platform: true,
                    name: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async list(workspaceId: string, status?: string) {
    return await this.prisma.campaign.findMany({
      where: {
        workspaceId,
        ...(status ? { status: status as any } : {}),
      } as any,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { posts: true } },
      },
    });
  }

  async delete(
    workspaceId: string,
    campaignId: string,
    mode: 'detach' | 'block' = 'detach',
  ) {
    await this.get(workspaceId, campaignId);

    const count = await this.prisma.post.count({
      where: { workspaceId, campaignId },
    });

    if (count > 0 && mode === 'block') {
      throw new BadRequestException(
        'Cannot delete campaign: campaign has posts',
      );
    }

    return await this.prisma.$transaction(async (tx) => {
      if (count > 0) {
        // Detach posts (set campaignId = null)
        await tx.post.updateMany({
          where: { workspaceId, campaignId },
          data: { campaignId: null },
        });
      }
      await tx.campaign.delete({ where: { id: campaignId } });
      return { ok: true, detachedPosts: count };
    });
  }

  async listPosts(workspaceId: string, campaignId: string) {
    await this.get(workspaceId, campaignId);
    return await this.prisma.post.findMany({
      where: { workspaceId, campaignId } as any,
      orderBy: { createdAt: 'desc' },
      include: {
        labels: true,
        destinations: true,
      } as any,
    });
  }
}
