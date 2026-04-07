// admin.security.repo.ts
import { PrismaService } from '@/prisma/prisma.service';
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class AdminSecurityRepo {
  constructor(private readonly prisma: PrismaService) {}
  // Get active sessions
  async getActiveSessions(adminId: string) {
    return this.prisma.adminSession.findMany({
      where: {
        adminId,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        ip: true,
        isActive: true,
        createdAt: true,
        admin: {
          select: {
            firstName: true,
            lastName: true,
            userType: true,
          },
        },
      },
    });
  }

  // Revoke single session
  async revokeSession(sessionId: string) {
    return this.prisma.adminSession.update({
      where: { id: sessionId },
      data: { isActive: false },
    });
  }

  // Revoke all except current
  async revokeOtherSessions(adminId: string, currentSessionId: string) {
    return this.prisma.adminSession.updateMany({
      where: {
        adminId,
        id: { not: currentSessionId },
      },
      data: { isActive: false },
    });
  }

  // Get IP whitelist
  async getWhitelist(adminId: string) {
    return this.prisma.ipWhitelist.findMany({
      where: { adminId },
    });
  }

  // Add IP
  async addIp(adminId: string, ipRange: string) {
    return this.prisma.ipWhitelist.create({
      data: { adminId, ipRange },
    });
  }

  // Remove IP
  async removeIp(id: string) {
    const record = await this.prisma.ipWhitelist.findFirst({
      where: { id },
    });

    if (!record) {
      throw new NotFoundException(`IP whitelist record not found`);
    }

    return this.prisma.ipWhitelist.delete({
      where: { id },
    });
  }

  // Rotate session tokens (invalidate all sessions)
  async rotateTokens(adminId: string) {
    return this.prisma.adminSession.updateMany({
      where: { adminId },
      data: { isActive: false },
    });
  }
}
