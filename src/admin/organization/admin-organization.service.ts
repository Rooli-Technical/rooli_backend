import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  AdminOrganizationRepository,
  AdminOrgListOptions,
} from './admin-organization.repository';

@Injectable()
export class AdminOrganizationService {
  constructor(private readonly repo: AdminOrganizationRepository) {}

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

  // ── DELETE ────────────────────────────────────────────────────────────────

  async deleteOrganization(id: string) {
    const org = await this.repo.findRaw(id);
    if (!org) throw new NotFoundException(`Organization ${id} not found`);

    return this.repo.deleteOrganization(id);
  }
}
