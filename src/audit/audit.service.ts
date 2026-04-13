import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@generated/client';
import { AuditAction, AuditResourceType } from '@generated/enums';
import { ListAuditLogsDto } from './dtos/list-audit-logs.dto';

export interface CreateAuditLogDto {
  organizationId: string;
  workspaceId: string;
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

    const sensitiveKeys = [
      'password',
      'token',
      'secret',
      'authorization',
      'creditcard',
    ];

    const seen = new WeakSet();

    const walk = (value: any, depth = 0): any => {
      if (depth > 6) return '[TRUNCATED_DEPTH]';

      if (value === null || value === undefined) return value;

      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function') return '[FUNCTION]';

      if (typeof value === 'string') {
        // avoid storing huge blobs
        return value.length > 2000
          ? value.slice(0, 2000) + '...[TRUNCATED]'
          : value;
      }

      if (Array.isArray(value)) {
        if (value.length > 50)
          return [...value.slice(0, 50), '[TRUNCATED_ARRAY]'];
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
        ? {
            actorUser: {
              email: { contains: query.actorEmail, mode: 'insensitive' },
            },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          actorUser: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          actorMember: { select: { id: true, userId: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
   

    const formattedItems = await this.formatAuditLogs(items);
    return {
      items: formattedItems,
      meta: {
        total,
        page: query.page ?? 1,
        limit: take,
        pages: Math.ceil(total / take),
      },
    };
  }

async formatAuditLogs(items: any[]) {
    const formattedItems = items.map(log => {
      const actorName = log.actorUser 
        ? `${log.actorUser.firstName} ${log.actorUser.lastName}` 
        : 'System';
      
      // 🛠️ The Translator Default
      let message = `${actorName} performed an action.`; 
      const detailsBody = (log.details as any)?.body || {};
      const action = log.action;

      switch (log.resourceType) {
        // ==========================================
        // TEAM & ACCESS
        // ==========================================
        case 'INVITATION':
          if (action === 'CREATE') message = `${actorName} invited ${detailsBody.email || 'a new user'}.`;
          if (action === 'DELETE') message = `${actorName} revoked an invitation.`;
          break;

        case 'MEMBER':
          if (action === 'UPDATE') message = `${actorName} updated a team member's role.`;
          if (action === 'DELETE') message = `${actorName} removed a team member.`;
          break;

        case 'ROLE':
          if (action === 'CREATE') message = `${actorName} created the custom role "${detailsBody.name || ''}".`;
          if (action === 'UPDATE') message = `${actorName} updated a custom role.`;
          if (action === 'DELETE') message = `${actorName} deleted a custom role.`;
          break;

        case 'AUTH':
          if (action === 'LOGIN') message = `${actorName} logged in.`;
          if (action === 'LOGOUT') message = `${actorName} logged out.`;
          break;

        // ==========================================
        // WORKSPACE & SOCIAL ACCOUNTS
        // ==========================================
        case 'WORKSPACE':
          // Catching your specific social connection payload
          if (detailsBody.platform) {
            message = `${actorName} connected a ${detailsBody.platform} account.`;
          } else {
            if (action === 'CREATE') message = `${actorName} created a new workspace.`;
            if (action === 'UPDATE') message = `${actorName} updated the workspace settings.`;
            if (action === 'DELETE') message = `${actorName} deleted a workspace.`;
          }
          break;

        case 'SOCIAL_ACCOUNT': // Just in case you log these separately later
          if (action === 'CREATE') message = `${actorName} connected a new social account.`;
          if (action === 'DELETE') message = `${actorName} disconnected a social account.`;
          if (action === 'UPDATE') message = `${actorName} re-authenticated a social account.`;
          break;

        // ==========================================
        // PUBLISHING ENGINE (POSTS & QUEUES)
        // ==========================================
        case 'POST':
          if (action === 'CREATE') {
            message = detailsBody.isAutoSchedule 
              ? `${actorName} auto-scheduled a new post.` 
              : `${actorName} created a new post.`;
          }
          if (action === 'UPDATE') message = `${actorName} edited a scheduled post.`;
          if (action === 'DELETE') message = `${actorName} deleted a post.`;
          if (action === 'BULK_ACTION') message = `${actorName} bulk-scheduled multiple posts.`;
          break;

        case 'QUEUE_SLOT':
          if (action === 'CREATE') message = `${actorName} added a new posting time slot.`;
          if (action === 'UPDATE') message = `${actorName} modified a queue schedule.`;
          if (action === 'DELETE') message = `${actorName} removed a posting time slot.`;
          if (action === 'BULK_ACTION') message = `${actorName} generated a default queue schedule.`;
          break;

        case 'APPROVAL':
          if (action === 'CREATE') message = `${actorName} submitted a post for approval.`;
          if (action === 'APPROVE') message = `${actorName} approved a pending post.`;
          if (action === 'REJECT') message = `${actorName} rejected a pending post.`;
          if (action === 'DELETE') message = `${actorName} canceled an approval request.`;
          break;

        // ==========================================
        // AI & MEDIA
        // ==========================================
        case 'AI': // Assuming you add this to your enum
          if (action === 'EXECUTE' || action === 'CREATE') {
            message = `${actorName} generated AI content.`;
          }
          break;

        // ==========================================
        // BILLING & ORGANIZATION
        // ==========================================
        case 'BILLING':
          if (action === 'UPDATE') message = `${actorName} updated the billing subscription.`;
          if (action === 'CREATE') message = `${actorName} subscribed to a new plan.`;
          break;

        case 'ORGANIZATION':
          if (action === 'UPDATE') message = `${actorName} updated the organization settings.`;
          break;

        // ==========================================
        // SUPPORT TICKETS
        // ==========================================
        case 'TICKET': // Assuming you add this to your enum
          if (action === 'CREATE') message = `${actorName} submitted a support ticket.`;
          if (action === 'UPDATE') message = `${actorName} closed a support ticket.`;
          break;
          
        case 'COMMENT':
          if (action === 'CREATE') message = `${actorName} added a comment to a ticket.`;
          break;
      }

      // Return a clean, UI-ready object
      return {
        id: log.id,
        message,
        actorName,
        action: log.action,
        resourceType: log.resourceType,
        ipAddress: log.ipAddress,
        createdAt: log.createdAt,
        rawDetails: log.details
      };
    });

    return formattedItems;
  }
}
