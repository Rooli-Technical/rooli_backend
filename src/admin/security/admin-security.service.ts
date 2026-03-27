import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminSecurityRepo } from './admin-security.repo';

@Injectable()
export class AdminSecurityService {
  constructor(private readonly adminSecurityRepo: AdminSecurityRepo) {}
  async getSecurityOverview(adminId: string) {
    const [sessions, whitelist] = await Promise.all([
      this.adminSecurityRepo.getActiveSessions(adminId),
      this.adminSecurityRepo.getWhitelist(adminId),
    ]);

    return {
      sessions,
      whitelist,
    };
  }

  async revokeSession(sessionId: string) {
    return this.adminSecurityRepo.revokeSession(sessionId);
  }

  async revokeOtherSessions(adminId: string, currentSessionId: string) {
    return this.adminSecurityRepo.revokeOtherSessions(
      adminId,
      currentSessionId,
    );
  }

  async addWhitelistIp(adminId: string, ipRange: string) {
    return this.adminSecurityRepo.addIp(adminId, ipRange);
  }

  async removeWhitelistIp(id: string) {
    return this.adminSecurityRepo.removeIp(id);
  }

  async rotateTokens(adminId: string) {
    return this.adminSecurityRepo.rotateTokens(adminId);
  }
}
