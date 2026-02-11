import { PrismaService } from '@/prisma/prisma.service';
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { CreateLabelDto } from './dto/request/create-label.dto';
import { UpdateLabelDto } from './dto/request/update-label.dto';
import { AttachLabelsToPostDto } from './dto/request/attach-label-to-post.dto';
import { SetLabelsForPostDto } from './dto/request/set-labels-for-post.dto';

@Injectable()
export class LabelService {
  constructor(private readonly prisma: PrismaService) {}

  async create(workspaceId: string, dto: CreateLabelDto) {
    const name = dto.name.trim();

    const exists = await this.prisma.label.findFirst({
      where: { workspaceId, name },
      select: { id: true },
    });
    if (exists) throw new BadRequestException('Label name already exists in this workspace');

    return await this.prisma.label.create({
      data: {
        workspaceId,
        name,
        color: dto.color ?? '#000000',
      },
    });
  }

  async list(workspaceId: string) {
    return await this.prisma.label.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
    });
  }

  async get(workspaceId: string, labelId: string) {
    const label = await this.prisma.label.findFirst({
      where: { id: labelId, workspaceId },
    });
    if (!label) throw new NotFoundException('Label not found');
    return label;
  }

  async update(workspaceId: string, labelId: string, dto: UpdateLabelDto) {
    await this.get(workspaceId, labelId);

    if (dto.name) {
      const exists = await this.prisma.label.findFirst({
        where: { workspaceId, name: dto.name.trim(), NOT: { id: labelId } },
        select: { id: true },
      });
      if (exists) throw new BadRequestException('Label name already exists in this workspace');
    }

    return await this.prisma.label.update({
      where: { id: labelId } as any,
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.color ? { color: dto.color } : {}),
      } as any,
    });
  }

  async delete(workspaceId: string, labelId: string, mode: 'detach' | 'block' = 'detach') {
    await this.get(workspaceId, labelId); // Validate ownership

    // Check usage
    const usageCount = await this.prisma.post.count({
      where: { workspaceId, labels: { some: { id: labelId } } },
    });

    if (usageCount > 0 && mode === 'block') {
      throw new BadRequestException('Cannot delete label: label is used by posts');
    }

    await this.prisma.label.delete({
      where: { id: labelId },
    });

    return { ok: true, detachedFromPosts: usageCount };
  }

  async getLabelAnalytics(workspaceId: string, labelId: string) {
    await this.get(workspaceId, labelId); // Validate

    // Fetch posts with this label
    const posts = await this.prisma.post.findMany({
      where: { 
        workspaceId, 
        labels: { some: { id: labelId } },
        destinations: { some: { status: 'SUCCESS' } }
      },
      include: {
        destinations: {
          where: { status: 'SUCCESS' },
          include: {
            postAnalyticsSnapshots: {
              orderBy: { fetchedAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    const stats = {
      labelId,
      totalPosts: posts.length,
      totalImpressions: 0,
      totalEngagements: 0, // Likes + Comments + Shares + Clicks
    };

    // Aggregate (Same logic as Campaign Analytics)
    for (const post of posts) {
      for (const dest of post.destinations) {
        const snapshot = dest.postAnalyticsSnapshots[0];
        if (snapshot) {
          stats.totalImpressions += snapshot.impressions || 0;
          stats.totalEngagements += 
            (snapshot.likes || 0) + 
            (snapshot.comments || 0) + 
            (snapshot.shares || 0) + 
            (snapshot.clicks || 0);
        }
      }
    }

    return stats;
  }

  async listPosts(workspaceId: string, labelId: string) {
    await this.get(workspaceId, labelId);
    return await this.prisma.post.findMany({
      where: { workspaceId, labels: { some: { id: labelId } } } as any,
      orderBy: { createdAt: 'desc' },
      include: {
        labels: true,
        destinations: true,
        campaign: true,
      } as any,
    });
  }

  // --------------------------
  // Post-Label relationship
  // --------------------------
  async attachToPost(workspaceId: string, postId: string, dto: AttachLabelsToPostDto) {
    // validate post exists
    const post = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId } as any,
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Post not found');

    // validate labels belong to workspace
    const labels = await this.prisma.label.findMany({
      where: { workspaceId, id: { in: dto.labelIds } },
      select: { id: true },
    });

    if (labels.length !== dto.labelIds.length) {
      throw new BadRequestException('One or more labels do not belong to this workspace');
    }

    return await this.prisma.post.update({
      where: { id: postId } as any,
      data: {
        labels: { connect: dto.labelIds.map((id) => ({ id })) } as any,
      } as any,
      include: { labels: true } as any,
    });
  }

  async setForPost(workspaceId: string, postId: string, dto: SetLabelsForPostDto) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId } as any,
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Post not found');

    // validate labels belong to workspace
    const labels = await this.prisma.label.findMany({
      where: { workspaceId, id: { in: dto.labelIds } },
      select: { id: true },
    });

    if (labels.length !== dto.labelIds.length) {
      throw new BadRequestException('One or more labels do not belong to this workspace');
    }

    return await this.prisma.post.update({
      where: { id: postId } as any,
      data: {
        labels: { set: dto.labelIds.map((id) => ({ id })) } as any,
      } as any,
      include: { labels: true } as any,
    });
  }

  async removeFromPost(workspaceId: string, postId: string, labelId: string) {
    await this.get(workspaceId, labelId);

    const post = await this.prisma.post.findFirst({
      where: { id: postId, workspaceId } as any,
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Post not found');

    return await this.prisma.post.update({
      where: { id: postId } as any,
      data: {
        labels: { disconnect: { id: labelId } } as any,
      } as any,
      include: { labels: true } as any,
    });
  }
}
