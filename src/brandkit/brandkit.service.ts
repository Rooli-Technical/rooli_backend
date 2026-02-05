import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@generated/client';
import { CreateBrandKitDto } from './dto/create-brandkit.dto';
import { UpdateBrandKitDto } from './dto/update-brandkit.dto';


@Injectable()
export class BrandKitService {
  constructor(private readonly prisma: PrismaService) {}

  async getByWorkspace(workspaceId: string) {
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
    });

    if (!kit) throw new NotFoundException('Brand kit not found for workspace');
    return kit;
  }

  async upsertForWorkspace(workspaceId: string, dto: CreateBrandKitDto | UpdateBrandKitDto) {
    // Normalize JSON fields
    const colors = dto.colors ? (dto.colors as unknown as Prisma.JsonObject) : undefined;
    const guidelines = dto.guidelines ? (dto.guidelines as unknown as Prisma.JsonObject) : undefined;

    // validate hex colors 
    this.assertValidColors(dto.colors);

    // Ensure workspace exists
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    return this.prisma.brandKit.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        name: dto.name ?? 'Our Brand',
        handle: dto.handle,
        logoUrl: dto.logoUrl,
        colors,
        brandVoice: dto.brandVoice,
        tone: dto.tone,
        guidelines,
        isActive: dto.isActive ?? true,
      },
      update: {
        name: dto.name,
        handle: dto.handle,
        logoUrl: dto.logoUrl,
        colors,
        brandVoice: dto.brandVoice,
        tone: dto.tone,
        guidelines,
        isActive: dto.isActive,
      },
    });
  }

  async ensureDefaultExists(workspaceId: string) {
    const existing = await this.prisma.brandKit.findUnique({ where: { workspaceId } });
    if (existing) return existing;

    // Create a minimal default kit
    return this.prisma.brandKit.create({
      data: {
        workspaceId,
        name: 'Our Brand',
        isActive: true,
      },
    });
  }

  // -----------------------
  // Helpers
  // -----------------------

  private assertValidColors(colors?: any) {
    if (!colors) return;
    const hex = /^#([0-9a-fA-F]{3}){1,2}$/;

    for (const key of Object.keys(colors)) {
      const value = colors[key];
      if (typeof value === 'string' && value.length > 0 && !hex.test(value)) {
        throw new BadRequestException(`Invalid hex color for ${key}: ${value}`);
      }
    }
  }
}
