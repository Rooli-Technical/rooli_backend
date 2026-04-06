import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { paginate, PaginatedResult } from '../admin.common.dto';

export interface AdminOrgListItem {
  id: string;
  name: string;
  slug: string;
  billingCountry: string;
  currency: string;
  status: string;
  isActive: boolean;
  createdAt: Date;
  // Plan from Subscription → Plan
  plan: {
    id: string;
    name: string;
    tier: string;
  } | null;
  // Counts
  memberCount: number;
  workspaceCount: number;
  socialCount: number;
  // Owner = first OWNER role member
  owner: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
}

export interface AdminOrgListOptions {
  search?: string;
  status?: string; // ACTIVE | SUSPENDED | PENDING_PAYMENT
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  limit: number;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AdminOrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // LIST ORGANIZATIONS
  // ─────────────────────────────────────────────────────────────────────────

  async listOrganizations(
    options: AdminOrgListOptions,
  ): Promise<PaginatedResult<AdminOrgListItem>> {
    const { search, status, dateFrom, dateTo, page, limit } = options;

    const searchWhere = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { slug: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const statusWhere = status ? { status: status as any } : {};

    const dateWhere =
      dateFrom || dateTo
        ? {
            createdAt: {
              ...(dateFrom ? { gte: dateFrom } : {}),
              ...(dateTo ? { lte: dateTo } : {}),
            },
          }
        : {};

    const where = { ...searchWhere, ...statusWhere, ...dateWhere };

    const [orgs, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          slug: true,
          billingCountry: true,
          currency: true,
          status: true,
          isActive: true,
          createdAt: true,

          // Plan via subscription
          subscription: {
            select: {
              plan: {
                select: { id: true, name: true, tier: true },
              },
            },
          },

          // Member count + owner lookup
          members: {
            select: {
              role: true,
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },

          // Workspace count
          _count: {
            select: {
              workspaces: true,
              members: true,
            },
          },

          // Social connections count
          socialConnections: {
            select: { id: true },
          },
        },
      }),
      this.prisma.organization.count({ where }),
    ]);

    const data: AdminOrgListItem[] = orgs.map((org) => {
      // Owner = member whose role name is OWNER (adjust to your role naming)
      const ownerMember = org.members.find(
        (m) => m.role?.name?.toUpperCase() === 'OWNER',
      );

      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        billingCountry: org.billingCountry,
        currency: org.currency,
        status: org.status,
        isActive: org.isActive,
        createdAt: org.createdAt,
        plan: org.subscription?.plan ?? null,
        memberCount: org._count.members,
        workspaceCount: org._count.workspaces,
        socialCount: org.socialConnections.length,
        owner: ownerMember?.user ?? null,
      };
    });

    return paginate(data, total, page, limit);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET ONE ORGANIZATION (for View details)
  // ─────────────────────────────────────────────────────────────────────────

  async findById(id: string) {
    return this.prisma.organization.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        email: true,
        billingEmail: true,
        billingCountry: true,
        currency: true,
        status: true,
        isActive: true,
        timezone: true,
        createdAt: true,
        updatedAt: true,
        totalCreditsUsed: true,
        subscription: {
          select: {
            status: true,
            isActive: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
            plan: {
              select: {
                id: true,
                name: true,
                tier: true,
                priceNgn: true,
                priceUsd: true,
                interval: true,
                maxWorkspaces: true,
                maxTeamMembers: true,
                maxSocialProfilesPerWorkspace: true,
                monthlyAiCredits: true,
              },
            },
          },
        },
        _count: {
          select: {
            workspaces: true,
            members: true,
            socialConnections: true,
            transactions: true,
          },
        },
        members: {
          select: {
            role: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SUSPEND ORGANIZATION
  // Sets status = SUSPENDED and isActive = false
  // ─────────────────────────────────────────────────────────────────────────

  async suspendOrganization(id: string) {
    return this.prisma.organization.update({
      where: { id },
      data: {
        status: 'SUSPENDED',
        isActive: false,
      },
      select: { id: true, name: true, status: true, isActive: true },
    });
  }


  async activateOrganization(id: string) {
    return this.prisma.organization.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        isActive: true,
      },
      select: { id: true, name: true, status: true, isActive: true },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE ORGANIZATION (soft: deactivate OR hard delete — pick one)
  // Using hard delete here since the model has no deletedAt field.
  // Cascade rules on Workspace → Posts etc. will handle children.
  // ─────────────────────────────────────────────────────────────────────────

  async deleteOrganization(id: string) {
    return this.prisma.organization.delete({
      where: { id },
      select: { id: true, name: true },
    });
  }

  async findRaw(id: string) {
    return this.prisma.organization.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, isActive: true },
    });
  }
}
