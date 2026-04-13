import { SetMetadata } from '@nestjs/common';

export const SKIP_AUDIT_KEY = 'skip_audit';

// Use this on specific routes to bypass the global interceptor
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);