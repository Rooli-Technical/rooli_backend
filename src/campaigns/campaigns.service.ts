import { PrismaService } from '@/prisma/prisma.service';
import { CampaignStatus } from '@generated/enums';
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { CreateCampaignDto } from './dto/request/create-campaign.dto';
import { UpdateCampaignDto } from './dto/request/update-campaign.dto';


@Injectable()
export class CampaignsService {
  constructor(private prisma: PrismaService) {}

  async create(workspaceId: string, dto: CreateCampaignDto) {
    this.validateDates(dto.startDate, dto.endDate);
    
    return this.prisma.campaign.create({
      data: {
        workspaceId,
        ...dto,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        status: dto.status || 'ACTIVE',
      },
    });
  }

  // Improved: Added Filtering
  async findAll(workspaceId: string, status?: CampaignStatus) {
    return this.prisma.campaign.findMany({
      where: { 
        workspaceId,
        ...(status ? { status } : {}) // Optional filter
      },
      include: {
        _count: { select: { posts: true } },
      },
      orderBy: { startDate: 'desc' },
    });
  }

  async findOne(workspaceId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, workspaceId },
      include: {
        posts: {
          take: 5,
          orderBy: { scheduledAt: 'desc' },
          select: { 
             id: true, 
             content: true, 
             status: true, 
             scheduledAt: true,
             media: { take: 1 } // Useful for showing a thumbnail in the UI
          }
        }
      }
    });

    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async update(workspaceId: string, id: string, dto: UpdateCampaignDto) {
    const existing = await this.findOne(workspaceId, id);

    // Validate logic only if dates are changing
    if (dto.startDate || dto.endDate) {
       const newStart = dto.startDate || existing.startDate.toISOString();
       const newEnd = dto.endDate !== undefined ? dto.endDate : existing.endDate?.toISOString();
       this.validateDates(newStart, newEnd);
    }

    return this.prisma.campaign.update({
      where: { id },
      data: {
        ...dto,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
    });
  }

  // ⭐️ Better than Delete: Archive
  async archive(workspaceId: string, id: string) {
    const result = await this.prisma.campaign.updateMany({
      where: { id, workspaceId },
      data: { status: 'ARCHIVED' }
    });
    if (result.count === 0) throw new NotFoundException('Campaign not found');
    return { message: 'Campaign archived' };
  }

  // Hard Delete (Use with caution)
  async remove(workspaceId: string, id: string) {
    // Logic to prevent deleting active campaigns with scheduled posts?
    const hasScheduled = await this.prisma.post.count({
      where: { campaignId: id, status: 'SCHEDULED' }
    });

    if (hasScheduled > 0) {
      throw new BadRequestException('Cannot delete a campaign with active scheduled posts. Archive it instead.');
    }

    const result = await this.prisma.campaign.deleteMany({
      where: { id, workspaceId },
    });
    if (result.count === 0) throw new NotFoundException('Campaign not found');
    return { success: true };
  }

  private validateDates(start: string, end?: string | null) {
    if (!end) return;
    if (new Date(end) < new Date(start)) {
      throw new BadRequestException('End date cannot be before start date.');
    }
  }
}
