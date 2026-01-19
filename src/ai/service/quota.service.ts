import { Injectable, BadRequestException } from '@nestjs/common';
import { BillingService } from '@/billing/billing.service';
import { RedisService } from '@/redis/redis.service';

@Injectable()
export class QuotaService {
  constructor(
    private redisService: RedisService,
  ) {}

  /**
   *  The Gatekeeper
   * Returns true if allowed, throws Exception if limit reached.
   */
  async checkAndIncrement(
    user: any, 
    workspaceId: string, 
    type: 'TEXT' | 'IMAGE'
  ): Promise<void> {
    
    // 1. Get Plan Limits
    const limit = this.getPlanLimit(user, type);

    // -1 means Unlimited
    if (limit === -1) return; 

    // 2. Generate Key (Reset monthly)
    const date = new Date();
    const key = `quota:${workspaceId}:${type}:${date.getFullYear()}-${date.getMonth() + 1}`;

  // 3. Check CURRENT usage (Read-only check first to prevent incrementing if blocked)
    const currentUsageStr = await this.redisService.get(key);
    const currentUsage = currentUsageStr ? parseInt(currentUsageStr) : 0;
    
   if (currentUsage >= limit) {
      throw new BadRequestException(
        `Monthly ${type.toLowerCase()} limit reached (${currentUsage}/${limit}). Upgrade your plan.`
      );
    }
    // 4. Increment (Atomic)
    const newValue = await this.redisService.incr(key);

    // 5. Set Expiry (Only if it's a new key)
    // If usage is 1, it means we just created this key. Set it to expire in 40 days.
    if (newValue === 1) {
      const secondsIn40Days = 60 * 60 * 24 * 40;
      await this.redisService.expire(key, secondsIn40Days);
    }

    // 6. Double Check (Race Condition Safety)
    // If two requests hit exact same time, both might pass step 3.
    // This atomic check catches the one that went over.
    if (newValue > limit) {
      // Refund the one we just took
      await this.redisService.decr(key); 
      throw new BadRequestException(
        `Monthly ${type.toLowerCase()} limit reached (${limit}/${limit}).`
      );
    }
  }

  /**
   * ↩️ Refund Logic
   * Call this if the AI Provider fails (e.g., OpenAI 500 Error)
   */
 async refundQuota(workspaceId: string, type: 'TEXT' | 'IMAGE') {
    const date = new Date();
    const key = `quota:${workspaceId}:${type}:${date.getFullYear()}-${date.getMonth() + 1}`;
    
    // Only decrement if the key exists (value > 0) to avoid negative numbers
    const currentStr = await this.redisService.get(key);
    if (currentStr && parseInt(currentStr) > 0) {
       await this.redisService.decr(key);
    }
  }

  /**
   * 📊 Helper: Define your Plan Logic here
   * (Ideally move this to SubscriptionService later)
   */
  private getPlanLimit(user: any, type: 'TEXT' | 'IMAGE'): number {
    // 1. Check for Custom Overrides (Enterprise)
    // const customLimit = user.organization?.subscription?.customLimits?.[type];
    // if (customLimit) return customLimit;

    // 2. Standard Plan Logic
    const planName = user.organization?.subscription?.plan?.name || 'FREE';

    // Simple Map
    const limits = {
      'CREATOR': { TEXT: 100, IMAGE: 10 },
      'BUSINESS': { TEXT: -1, IMAGE: 50 },  // -1 = Unlimited
      'ROCKET':   { TEXT: -1, IMAGE: 200 },
      'FREE':     { TEXT: 10, IMAGE: 0 }
    };

    const planLimits = limits[planName] || limits['FREE'];
    return planLimits[type];
  }
}