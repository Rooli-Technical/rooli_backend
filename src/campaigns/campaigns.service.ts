import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCampaignDto } from './dto/request/create-campaign.dto';
import { UpdateCampaignDto } from './dto/request/update-campaign.dto';
import { PublishStatus } from '@generated/enums';

@Injectable()
export class CampaignService {
  constructor(private readonly prisma: PrismaService) {}

  // CREATE
  async create(workspaceId: string, dto: CreateCampaignDto) {
    // Basic check is fine for create since both are usually required or null
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

  // 2. UPDATE (Fixed Logic)
async update(workspaceId: string, campaignId: string, dto: UpdateCampaignDto) {
    const campaign = await this.get(workspaceId, campaignId); // Fetch existing

    // ✅ FIX: Compare New vs Old values to ensure integrity
    const newStart = dto.startDate ? new Date(dto.startDate) : campaign.startDate;
    const newEnd = dto.endDate !== undefined 
      ? (dto.endDate ? new Date(dto.endDate) : null) 
      : campaign.endDate;

    if (newEnd && newStart && newEnd < newStart) {
      throw new BadRequestException('End date cannot be before start date');
    }

    // Uniqueness Check (Only if name changed)
    if (dto.name && dto.name !== campaign.name) {
      const existing = await this.prisma.campaign.findFirst({
        where: { workspaceId, name: dto.name, NOT: { id: campaignId } },
        select: { id: true },
      });
      if (existing) throw new BadRequestException('Campaign name already exists');
    }

    return this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        name: dto.name?.trim(),
        description: dto.description, // allows null
        color: dto.color,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : (dto.endDate === null ? null : undefined),
        status: dto.status,
      },
    });
  }

 async getCampaignAnalytics(workspaceId: string, campaignId: string) {
    // 1. Validate Campaign Existence
    await this.get(workspaceId, campaignId);

    // 2. Fetch Hierarchy
    // We get all posts for this campaign that have at least one published destination
    const posts = await this.prisma.post.findMany({
      where: { 
        workspaceId, 
        campaignId,
        // We only care about posts that actually went out
        destinations: { some: { status: PublishStatus.SUCCESS } } 
      },
      include: {
        destinations: {
          where: { status: PublishStatus.SUCCESS },
          include: {
            // Get the MOST RECENT snapshot for this destination
            postAnalyticsSnapshots: {
              orderBy: { fetchedAt: 'desc' }, // or createdAt
              take: 1,
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
      totalEngagements: 0, // Likes + Comments + Shares + Clicks
      totalLikes: 0,
      totalComments: 0,
      totalShares: 0,
      totalClicks: 0,
    };

    // 4. Manual Aggregation
    for (const post of posts) {
      for (const dest of post.destinations) {
        // Grab the latest snapshot (if it exists)
        const snapshot = dest.postAnalyticsSnapshots[0];
        
        if (snapshot) {
          // Assuming your Snapshot model has these standard integer fields:
          stats.totalImpressions += snapshot.impressions || 0;
          stats.totalReach += snapshot.reach || 0;
          stats.totalLikes += snapshot.likes || 0;
          stats.totalComments += snapshot.comments || 0;
          stats.totalShares += snapshot.shares || 0;
          stats.totalClicks += snapshot.clicks || 0;
          
          // Calculate total engagement just in case the snapshot doesn't store it pre-calculated
          stats.totalEngagements += (snapshot.likes || 0) + (snapshot.comments || 0) + (snapshot.shares || 0) + (snapshot.clicks || 0);
        }
      }
    }

    return stats;
  }

  async get(workspaceId: string, campaignId: string) {
    const c = await this.prisma.campaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }
    
  async list(workspaceId: string, status?: string) {
    return await this.prisma.campaign.findMany({
      where: { workspaceId, ...(status ? { status: status as any } : {}) } as any,
      orderBy: { createdAt: 'desc' },
      include: {
          _count: { select: { posts: true } } // Helpful for UI
      }
    });
  }
  
  async delete(workspaceId: string, campaignId: string, mode: 'detach' | 'block' = 'detach') {
    await this.get(workspaceId, campaignId);

    const count = await this.prisma.post.count({
      where: { workspaceId, campaignId },
    });

    if (count > 0 && mode === 'block') {
      throw new BadRequestException('Cannot delete campaign: campaign has posts');
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
