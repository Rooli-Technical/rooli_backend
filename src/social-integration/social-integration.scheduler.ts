import { PrismaService } from '@/prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';

@Injectable()
export class AuthScheduler {
  private readonly logger = new Logger(AuthScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('auth') private authQueue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async scheduleTokenRefreshes() {
    const now = new Date();

    // Refresh if expiring in the next 3 days
    const refreshThreshold = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const expiringAccounts = await this.prisma.socialAccount.findMany({
      where: {
        isActive: true,
        OR: [
          {
            platform: 'LINKEDIN',
            tokenExpiresAt: { lte: refreshThreshold },
          },
          {
            platform: 'META',
            tokenExpiresAt: { lte: refreshThreshold },
          },
        ],
      },
      select: { id: true, platform: true },
    });

    if (expiringAccounts.length === 0) return;

    for (const acc of expiringAccounts) {
      await this.authQueue.add('refresh-token', {
        accountId: acc.id,
        platform: acc.platform,
      });
    }
  }
}
