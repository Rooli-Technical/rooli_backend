import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit.service';
import { Request, Response } from 'express';
import { AuditAction, AuditResourceType } from '@generated/enums';

export const AUDIT_CONTEXT_KEY = 'audit_context';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const method = req.method;

    if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') {
      return next.handle();
    }

    const user = (req as any).user;
    const orgId = (req as any).orgId ?? (req as any).orgMember?.organizationId;

    if (!user || !orgId) return next.handle();

    // 🚨 FIX 1: Extract Workspace ID (Checks Headers, Params, then Body)
    const workspaceId = 
      req.headers['x-workspace-id'] || 
      req.params?.workspaceId || 
      req.body?.workspaceId || 
      null;

    const decoration = this.reflector.get(AUDIT_CONTEXT_KEY, context.getHandler());
    const action = decoration?.action ?? this.mapMethodToAction(method);
    const resourceType =
      decoration?.resource ??
      this.guessResourceFromUrl(req.originalUrl || req.url);

    return next.handle().pipe(
      tap((data) => {
        // NestJS 'tap' only fires on success, but this is a good safety check
        if (res.statusCode >= 400) return;

        const resourceId = (data as any)?.id ?? req.params?.id ?? undefined;

        void this.auditService.log({
          organizationId: orgId,
          workspaceId: workspaceId as string, 
          actorUserId: user?.userId ?? user?.id,
          actorMemberId: (req as any).orgMember?.id,
          action,
          resourceType,
          resourceId,
          details: {
            body: this.sanitizeBody(req.body), 
            query: req.query,
            params: req.params,
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }),
    );
  }

  // 🛡️ THE SANITIZER: Keeps passwords and tokens out of your audit logs
  private sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') return body;
    
    const sanitized = { ...body };
    const sensitiveKeys = ['password', 'accessToken', 'refreshToken', 'token', 'secret', 'otp'];
    
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.includes(key)) {
        sanitized[key] = '***REDACTED***';
      } else if (typeof sanitized[key] === 'object') {
        sanitized[key] = this.sanitizeBody(sanitized[key]); 
      }
    }
    return sanitized;
  }

  private mapMethodToAction(method: string): AuditAction {
    switch (method) {
      case 'POST':
        return AuditAction.CREATE;
      case 'PUT':
      case 'PATCH':
        return AuditAction.UPDATE;
      case 'DELETE':
        return AuditAction.DELETE;
      default:
        return AuditAction.UPDATE;
    }
  }

  private guessResourceFromUrl(url: string): AuditResourceType {
    const path = url.split('?')[0];

    if (path.includes('/posts')) return AuditResourceType.POST;
    if (path.includes('/members')) return AuditResourceType.MEMBER;
    if (path.includes('/workspaces')) return AuditResourceType.WORKSPACE;
    if (path.includes('/billing')) return AuditResourceType.BILLING;
    if (path.includes('/invitations')) return AuditResourceType.INVITATION;
    if (path.includes('/roles')) return AuditResourceType.ROLE;
    if (path.includes('/approvals')) return AuditResourceType.APPROVAL; 
    if (path.includes('/comments')) return AuditResourceType.COMMENT;   

    return AuditResourceType.ORGANIZATION;
  }
}
