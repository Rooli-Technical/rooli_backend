import { PrismaService } from '@/prisma/prisma.service';
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { CreateLabelDto } from './dto/request/create-label.dto';
import { UpdateLabelDto } from './dto/request/update-label.dto';


@Injectable()
export class LabelsService {
  constructor(private prisma: PrismaService) {}

  async create(workspaceId: string, dto: CreateLabelDto) {
    const exists = await this.prisma.label.findUnique({
      where: { workspaceId_name: { workspaceId, name: dto.name } },
    });
    if (exists) throw new BadRequestException(`Label '${dto.name}' already exists.`);

    return this.prisma.label.create({
      data: { ...dto, workspaceId },
    });
  }

  async findAll(workspaceId: string) {
    return this.prisma.label.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateLabelDto) {
    // We use updateMany as a safety trick: it only updates if BOTH id and workspace match.
    // This avoids a separate "findFirst" call to check ownership.
    const result = await this.prisma.label.updateMany({
      where: { id, workspaceId },
      data: { ...dto },
    });

    if (result.count === 0) throw new NotFoundException('Label not found or access denied');
    return { success: true };
  }

  async remove(workspaceId: string, id: string) {
    const result = await this.prisma.label.deleteMany({
      where: { id, workspaceId },
    });
    if (result.count === 0) throw new NotFoundException('Label not found');
    return { success: true };
  }
}
