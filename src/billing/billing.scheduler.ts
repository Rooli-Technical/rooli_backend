import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BillingScheduler {
  private readonly logger = new Logger(BillingScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleExpiredSubscriptions() {
    const now = new Date();
    // 24-hour grace period for payment processing delays
    const gracePeriod = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 1. Find ACTIVE subs that passed their end date
    const expiredSubs = await this.prisma.subscription.findMany({
      where: {
        status: 'active',
        currentPeriodEnd: { lt: gracePeriod }
      },
      select: { id: true, organizationId: true }
    });

    if (expiredSubs.length === 0) return;

    this.logger.log(`Locking ${expiredSubs.length} expired organizations...`);

    for (const sub of expiredSubs) {
      // A. Mark Subscription as EXPIRED
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'expired' }
      });

      // B. "Hard Stop" Background Jobs
      // We set all their social accounts to inactive. 
      // This ensures your Analytics Scheduler ignores them immediately.
      await this.prisma.socialAccount.updateMany({
        where: { organizationId: sub.organizationId },
        data: { 
          isActive: false, 
          errorMessage: 'Subscription Expired' 
        }
      });
      
      this.logger.log(`Locked Org ${sub.organizationId} and disabled background jobs.`);
    }
  }
}