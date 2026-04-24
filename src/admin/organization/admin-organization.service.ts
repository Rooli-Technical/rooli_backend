import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  AdminOrganizationRepository,
  AdminOrgListOptions,
} from './admin-organization.repository';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class AdminOrganizationService {
  constructor(
    private readonly repo: AdminOrganizationRepository,
    private readonly prisma: PrismaService,
  ) {}

  // ── LIST ──────────────────────────────────────────────────────────────────

  async listOrganizations(options: {
    search?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    page: number;
    limit: number;
  }) {
    const validStatuses = ['ACTIVE', 'SUSPENDED', 'PENDING_PAYMENT'];

    if (
      options.status &&
      !validStatuses.includes(options.status.toUpperCase())
    ) {
      throw new BadRequestException(
        `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      );
    }

    const listOptions: AdminOrgListOptions = {
      search: options.search,
      status: options.status?.toUpperCase(),
      page: options.page,
      limit: options.limit,
      dateFrom: options.dateFrom ? new Date(options.dateFrom) : undefined,
      dateTo: options.dateTo ? new Date(options.dateTo) : undefined,
    };

    return this.repo.listOrganizations(listOptions);
  }

  // ── VIEW DETAILS ──────────────────────────────────────────────────────────

  async getOrganizationDetails(id: string) {
    const org = await this.repo.findById(id);
    if (!org) throw new NotFoundException(`Organization ${id} not found`);
    return org;
  }

  // ── SUSPEND ───────────────────────────────────────────────────────────────

  async suspendOrganization(id: string) {
    const org = await this.repo.findRaw(id);
    if (!org) throw new NotFoundException(`Organization ${id} not found`);

    if (org.status === 'SUSPENDED') {
      throw new BadRequestException('Organization is already suspended.');
    }

    return this.repo.suspendOrganization(id);
  }

  async activateOrganization(id: string) {
    const org = await this.repo.findRaw(id);
    if (!org) throw new NotFoundException(`Organization ${id} not found`);

    if (org.status === 'ACTIVE') {
      throw new BadRequestException('Organization is already activated.');
    }

    return this.repo.activateOrganization(id);
  }

  // ---------------------------------------------------------
  // ADMIN ACCOUNT RECOVERY (The Sledgehammer)
  // ---------------------------------------------------------
  async unsuspendOrganization(orgId: string) {
    const [sub, org] = await Promise.all([
      this.prisma.subscription.findUnique({
        where: { organizationId: orgId },
      }),
      this.prisma.organization.findUnique({
        where: { id: orgId },
      }),
    ]);

    if (!org) throw new NotFoundException('Organization not found');

    const now = new Date();
    // If they have no sub, or their sub ran out while they were suspended, they need to pay.
    const needsPayment = !sub || sub.currentPeriodEnd <= now; 

    // 🚨 PAYSTACK CALLS REMOVED ENTIRELY
    // We assume any previous Paystack contract is either dead or untrustworthy.
    // We handle their recovery entirely through our local database.

    // ==========================================
    // FAST DATABASE TRANSACTION
    // ==========================================
    const result = await this.prisma.$transaction(async (tx) => {
      
      // A. If they have time left on the clock, wake up their premium features
      if (!needsPayment && sub) {
        await tx.subscription.update({
          where: { organizationId: orgId },
          data: {
            // Force the yellow banner! They must resubscribe next month.
            cancelAtPeriodEnd: true, 
            status: sub.isTrial ? 'TRIALING' : 'ACTIVE',
            isActive: true, 
          },
        });

        // Wake up their social profiles
        await tx.socialProfile.updateMany({
          where: { workspace: { organizationId: orgId } },
          data: { isActive: true },
        });
      }

      // B. Wake up the Organization entity
      await tx.organization.update({
        where: { id: orgId },
        data: {
          isActive: true, // Let them log in!
          readOnly: needsPayment ? true : false,
          status: needsPayment ? 'PAYMENT_METHOD_REQUIRED' : 'ACTIVE',
          billingStatus: needsPayment 
            ? 'PAYMENT_METHOD_REQUIRED' 
            : (sub?.isTrial ? 'TRIAL_ACTIVE' : 'ACTIVE') // Matches your ENUM perfectly
        },
      });

      // C. Wake up all their team members
      await tx.organizationMember.updateMany({
        where: { organizationId: orgId },
        data: { isActive: true },
      });

      // D. Generate the Admin Report Message
      let message = 'Organization fully restored and active.';
      if (needsPayment) {
        message = 'Organization unbanned. User must update payment method to restore full access.';
      } else if (sub) {
        message = 'Organization restored for the remainder of their cycle. User will need to resubscribe next month.';
      }

      return { success: true, message, needsPayment };
    });
    
    return result;
  }

  // ── DELETE ────────────────────────────────────────────────────────────────

  async deleteOrganization(id: string) {
    const org = await this.repo.findRaw(id);
    if (!org) throw new NotFoundException(`Organization ${id} not found`);

    return this.repo.deleteOrganization(id);
  }

  async getOrganizationMetrics() {
    return this.repo.getOrganizationMetrics();
  }
}
