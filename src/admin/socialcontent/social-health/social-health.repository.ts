import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Platform, PostStatus } from '@generated/enums';
import { FailedPostJobDto, QueryPostDto } from './social-health.dto';
import { plainToInstance } from 'class-transformer';

@Injectable()
export class SocialHealthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Platform API Health — one row per platform
  async getPlatformHealth() {
    const platforms = Object.values(Platform);

    const results = await Promise.all(
      platforms.map(async (platform) => {
        const [totalAccounts, expiredTokens, disconnectedCount] =
          await Promise.all([
            this.prisma.socialProfile.count({
              where: { platform, isActive: true },
            }),
            this.prisma.socialConnection.count({
              where: {
                platform,
                tokenExpiresAt: { lt: new Date() },
              },
            }),
            this.prisma.socialProfile.count({
              where: {
                platform,
                status: 'DISCONNECTED',
              },
            }),
          ]);

        let status: string;

        if (totalAccounts === 0) {
          status = 'Not Connected';
        } else if (disconnectedCount === totalAccounts) {
          status = 'Disconnected';
        } else if (expiredTokens > 0 || disconnectedCount > 0) {
          status = 'Degraded';
        } else {
          status = 'Operational';
        }
        return {
          platform,
          totalAccounts,
          expiredTokens,
          disconnectedCount, // 👈 added here
          status,
        };
      }),
    );
    return results.filter((r) => r.totalAccounts > 0);
  }
  // Dead-letter queue — blocked rate limit logs
  async getDeadLetterQueue() {
    const where = {
      status: 'blocked',
    };

    return this.prisma.platformRateLimitLog.findMany({
      where,
      orderBy: { consumedAt: 'desc' },
      take: 50,
    });
  }

  async failedPostJobs(page = 1, limit = 20): Promise<FailedPostJobDto[]> {
    const posts = await this.prisma.post.findMany({
      where: {
        status: 'FAILED',
        errorMessage: { not: null },
      },
      skip: (page - 1) * Number(limit),
      take: Number(limit),
      orderBy: [{ retryCount: 'asc' }, { createdAt: 'desc' }],
      include: {
        destinations: {
          include: {
            profile: {
              select: { platform: true },
            },
          },
        },
      },
    });

    const mapped = posts.map((post) => ({
      id: post.id,
      content: post.content,
      status: post.status,
      errorMessage: post.errorMessage,
      retryCount: post.retryCount,
      maxRetries: post.maxRetries,
      isRetryable: post.retryCount < post.maxRetries,
      createdAt: post.createdAt,
      destinations: post.destinations.map((d) => ({
        platform: d.profile?.platform,
        status: d.status,
        errorMessage: d.errorMessage,
        publishedAt: d.publishedAt,
      })),
    }));

    return plainToInstance(FailedPostJobDto, mapped, {
      excludeExtraneousValues: true,
    });
  }
}
