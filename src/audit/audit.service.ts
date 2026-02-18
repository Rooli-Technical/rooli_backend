import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@generated/client';
import { AuditAction, AuditResourceType } from '@generated/enums';
import { ListAuditLogsDto } from './dtos/list-audit-logs.dto';

export interface CreateAuditLogDto {
  organizationId: string;
  actorUserId?: string;
  actorMemberId?: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write a log entry.
   * This is "fire and forget" - we don't await it in the controller to keep the API fast.
   */
  async log(dto: CreateAuditLogDto) {
    try {
      // 1. Sanitize sensitive fields from details
      const sanitizedDetails = this.sanitize(dto.details);

      // 2. Write to DB
      await this.prisma.auditLog.create({
        data: {
          organizationId: dto.organizationId,
          actorUserId: dto.actorUserId,
          actorMemberId: dto.actorMemberId,
          action: dto.action,
          resourceType: dto.resourceType,
          resourceId: dto.resourceId,
          details: sanitizedDetails ?? Prisma.JsonNull,
          ipAddress: dto.ipAddress,
          userAgent: dto.userAgent,
        },
      });
    } catch (error) {
      // 🚨 CRITICAL: Never let logging failure crash the app
      this.logger.error('Failed to create audit log', error);
    }
  }

  // Basic sanitization to prevent saving passwords in logs
  private sanitize(data: any): any {
  if (!data) return null;

  const sensitiveKeys = ['password', 'token', 'secret', 'authorization', 'creditcard'];

  const seen = new WeakSet();

  const walk = (value: any, depth = 0): any => {
    if (depth > 6) return '[TRUNCATED_DEPTH]';

    if (value === null || value === undefined) return value;

    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return '[FUNCTION]';

    if (typeof value === 'string') {
      // avoid storing huge blobs
      return value.length > 2000 ? value.slice(0, 2000) + '...[TRUNCATED]' : value;
    }

    if (Array.isArray(value)) {
      if (value.length > 50) return [...value.slice(0, 50), '[TRUNCATED_ARRAY]'];
      return value.map((v) => walk(v, depth + 1));
    }

    if (typeof value === 'object') {
      if (seen.has(value)) return '[CIRCULAR]';
      seen.add(value);

      const out: Record<string, any> = {};
      for (const key of Object.keys(value)) {
        const lowered = key.toLowerCase();
        if (sensitiveKeys.some((k) => lowered.includes(k))) {
          out[key] = '[REDACTED]';
        } else {
          out[key] = walk(value[key], depth + 1);
        }
      }
      return out;
    }

    return value;
  };

  return walk(data);
}

 async listOrganizationLogs(params: {
    organizationId: string;
    query: ListAuditLogsDto;
  }) {
    const { organizationId, query } = params;

    const take = Math.min(query.limit ?? 20, 100);
    const skip = (Math.max(query.page ?? 1, 1) - 1) * take;

    const where: Prisma.AuditLogWhereInput = {
      organizationId,
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.actorEmail
        ? { actorUser: { email: { contains: query.actorEmail, mode: 'insensitive' } } }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          actorUser: { select: { id: true, email: true, firstName: true, lastName: true } },
          actorMember: { select: { id: true, userId: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page: query.page ?? 1,
        limit: take,
        pages: Math.ceil(total / take),
      },
    };
  }
}
