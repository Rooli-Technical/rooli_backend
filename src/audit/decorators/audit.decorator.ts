import { AuditAction, AuditResourceType } from '@generated/enums';
import { SetMetadata } from '@nestjs/common';
import { AUDIT_CONTEXT_KEY } from '../interceptors/audit.intercetor';


export interface AuditOptions {
  action: AuditAction;
  resource: AuditResourceType;
}

export const AuditContext = (options: AuditOptions) =>
  SetMetadata(AUDIT_CONTEXT_KEY, options);