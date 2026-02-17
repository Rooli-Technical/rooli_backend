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
import { ListMembersQueryDto } from './dtos/list-members.dto';
import { Prisma } from '@generated/client';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
  ) {}

 async createOrganization(userId: string, dto: CreateOrganizationDto) {
    // 1. Update User Type (Onboarding)
    if (dto.userType) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { userType: dto.userType },
      });
    }

    // 2. Fetch User & Check Limits
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        organizationMemberships: {
          where: { role: { slug: 'owner' } },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');

   
    // 3. Prepare Slug (Respect DTO, Fallback to Name)
    let slug = dto.slug;
    if (!slug) {
      slug = slugify(dto.name, { lower: true, strict: true });
    }

    // 4. Check Uniqueness
    const existing = await this.prisma.organization.findUnique({
      where: { slug },
    });
    if (existing) {
      throw new ConflictException('Organization URL (slug) is already taken.');
    }

    let organization; // Declare outside to access in catch block

    try {
      // 5. Transaction: Create DB Record
      organization = await this.prisma.$transaction(async (tx) => {
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

        const ownerRole = await tx.role.findFirst({ where: { slug: 'owner' } });
        if (!ownerRole) throw new InternalServerErrorException("Role 'owner' missing");

        await tx.organizationMember.create({
          data: {
            organizationId: org.id,
            userId,
            roleId: ownerRole.id,
            invitedByUserId: userId,
          },
        });


        return org;
      });

      // 6. Initialize Payment
      const paymentData = await this.billingService.initializePayment(
        organization.id,
        dto.planId,
        user,
      );

      return {
        organization,
        payment: paymentData,
      };

    } catch (err) {
      console.log(err);
      // COMPENSATING TRANSACTION:
      // If payment failed (or any other error after DB creation), 
      // we should delete the 'Zombie' org so the user can retry with the same slug.
      if (organization?.id) {
        await this.prisma.organization.delete({ where: { id: organization.id } }).catch(() => {});
      }
      
      this.logger.error('Failed to create organization', err);
      throw err;
    }
  }

  async getOrganization(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId, isActive: true },
      include: {
        _count: {
          select: { members: true },
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
     await tx.organization.update({
        where: { id: orgId },
        data: { 
          isActive: false, 
          status: 'SUSPENDED' 
        },
      });
      // Cancel any active subscriptions
      //await this.cancelSubscription(orgId);

      return { success: true, message: 'Organization deleted successfully' };
    });
  }

  async listOrganizationMembers(params: {
  organizationId: string;
  query?: ListMembersQueryDto; 
}) {
  const { organizationId, query } = params;

  // 1. Verify Organization exists
  const organization = await this.prisma.organization.findUnique({
    where: { id: organizationId },
  });
  if (!organization) throw new NotFoundException('Organization not found');

  // 2. Pagination Logic
  const take = Math.min(query?.limit ?? 20, 100);
  const skip = ((query?.page ?? 1) - 1) * take;

  // 3. Search Filter (Email, First Name, Last Name)
  const search = query?.search?.trim();
  const where: Prisma.OrganizationMemberWhereInput = {
    organizationId,
    ...(search
      ? {
          user: {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
            ],
          },
        }
      : {}),
  };

  // 4. Execute Fetch
  const [items, total] = await this.prisma.$transaction([
    this.prisma.organizationMember.findMany({
      where,
      take,
      skip,
      orderBy: { createdAt: 'desc' },
      include: {
        role: true, // The Organization-level role (e.g., Owner, Admin, Member)
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            avatar: true,
            lastActiveAt: true,
          },
        },
      },
    }),
    this.prisma.organizationMember.count({ where }),
  ]);

  return {
    items,
    meta: {
      total,
      page: query?.page ?? 1,
      limit: take,
      totalPages: Math.ceil(total / take),
    },
  };
}


  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT) // Run once a day
  async cleanupAbandonedOrganizations() {
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - 48); // 48 Hours ago

    // Find orgs that were created > 48 hours ago but never paid
    const abandoned = await this.prisma.organization.deleteMany({
      where: {
        status: 'PENDING_PAYMENT',
        createdAt: { lt: cutoffDate } // Older than 48 hours
      }
    });

    if (abandoned.count > 0) {
      this.logger.log(`Cleaned up ${abandoned.count} abandoned organizations.`);
    }
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
