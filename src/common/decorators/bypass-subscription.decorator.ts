import { SetMetadata } from '@nestjs/common';

export const BYPASS_SUB_KEY = 'bypassSubscription';
export const BypassSubscription = () => SetMetadata(BYPASS_SUB_KEY, true);
