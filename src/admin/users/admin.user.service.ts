import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AdminUserRepository, UserStatusFilter } from './admin.user.repository';

@Injectable()
export class AdminUserService {
  constructor(private readonly adminUserRepository: AdminUserRepository) {}

  async listUsers(options: {
    status?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    page: number;
    limit: number;
  }) {
    const validStatuses: UserStatusFilter[] = [
      'ALL',
      'ACTIVE',
      'SUSPENDED',
      'BANNED',
    ];
    const status = (options.status?.toUpperCase() ?? 'ALL') as UserStatusFilter;

    if (!validStatuses.includes(status)) {
      throw new BadRequestException(
        `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      );
    }

    return this.adminUserRepository.listUsers({
      status,
      search: options.search,
      page: options.page,
      limit: options.limit,
      dateFrom: options.dateFrom ? new Date(options.dateFrom) : undefined,
      dateTo: options.dateTo ? new Date(options.dateTo) : undefined,
    });
  }

  async suspendUser(id: string, until?: string) {
    const user = await this.adminUserRepository.findById(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    if (user.deletedAt)
      throw new BadRequestException(
        'Cannot suspend a banned user. Reactivate them first.',
      );

    const lockUntil = until ? new Date(until) : undefined;
    if (lockUntil && isNaN(lockUntil.getTime()))
      throw new BadRequestException('Invalid suspendUntil date.');
    if (lockUntil && lockUntil <= new Date())
      throw new BadRequestException('suspendUntil must be a future date.');

    return this.adminUserRepository.suspendUser(id, lockUntil);
  }

  async reactivateUser(id: string) {
    const user = await this.adminUserRepository.findById(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    if (!user.lockedUntil && !user.deletedAt)
      throw new BadRequestException('User is already active.');

    return this.adminUserRepository.reactivateUser(id);
  }

  async getAdmins() {
    return await this.adminUserRepository.getAdmins();
  }
}
