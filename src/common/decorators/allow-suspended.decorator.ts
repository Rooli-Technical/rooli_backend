import { SetMetadata } from '@nestjs/common';

export const ALLOW_SUSPENDED_KEY = 'allowSuspended';
// Use this on endpoints that suspended users MUST be able to access (like billing & reactivation)
export const AllowSuspended = () => SetMetadata(ALLOW_SUSPENDED_KEY, true);