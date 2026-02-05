import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@generated/client';
import { Injectable } from '@nestjs/common';

import { startOfDay, subDays, endOfDay } from 'date-fns';

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================
  // 1. FETCHING HISTORY (For Normalizer)
  // ==========================================

  async getLastAccountSnapshot(socialProfileId: string) {
    return this.prisma.accountAnalytics.findFirst({
      where: { socialProfileId, date: { lt: startOfDay(new Date()) } },
      orderBy: { date: 'desc' },
    });
  }

  /**
   * Finds the active posts that we should update stats for.
   * Strategy: Get the last 30 posts or posts created in the last 14 days.
   */
  async getPostsForUpdate(socialProfileId: string, limit = 30) {
    return this.prisma.postDestination.findMany({
      where: {
        socialProfileId,
        platformPostId: { not: null },
        // Optional: Only fetch posts younger than 30 days to save API calls
        createdAt: { gte: subDays(new Date(), 30) },
        status: 'SUCCESS',
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        platformPostId: true, // The ID needed for the API (e.g., LinkedIn URN)
      },
    });
  }

  // ==========================================
  // 2. SAVING DATA (Upsert Logic)
  // ==========================================

  async saveAccountAnalytics(
    data: Prisma.AccountAnalyticsUncheckedCreateInput,
  ) {
    const dateKey = startOfDay(new Date(data.date));

    return this.prisma.accountAnalytics.upsert({
      where: {
        socialProfileId_date: {
          socialProfileId: data.socialProfileId,
          date: dateKey,
        },
      },
      update: {
        ...data,
        date: dateKey,
        updatedAt: new Date(),
      },
      create: {
        ...data,
        date: dateKey,
      },
    });
  }

  async savePostSnapshot(
    data: Prisma.PostAnalyticsSnapshotUncheckedCreateInput,
  ) {
    const dateKey = startOfDay(new Date(data.day));

    return this.prisma.postAnalyticsSnapshot.upsert({
      where: {
        postDestinationId_day: {
          postDestinationId: data.postDestinationId,
          day: dateKey,
        },
      },
      update: {
        ...data,
        day: dateKey,
        fetchedAt: new Date(),
      },
      create: {
        ...data,
        day: dateKey,
      },
    });
  }

  // ==========================================
  // 3. DASHBOARD QUERIES (Read-Time)
  // ==========================================

  async getAggregateAccountStats(
    socialProfileId: string,
    startDate: Date,
    endDate: Date,
  ) {
    return this.prisma.accountAnalytics.aggregate({
      _sum: {
        impressions: true,
        reach: true,
        followersGained: true,
        engagementCount: true,
        profileViews: true,
        clicks: true,
      },
      // Get the follower count from the MOST RECENT day in the range
      _max: {
        followersTotal: true,
      },
      where: {
        socialProfileId,
        date: {
          gte: startOfDay(startDate),
          lte: endOfDay(endDate),
        },
      },
    });
  }

  async getDailyHistory(
    socialProfileId: string,
    startDate: Date,
    endDate: Date,
  ) {
    return this.prisma.accountAnalytics.findMany({
      where: {
        socialProfileId,
        date: {
          gte: startOfDay(startDate),
          lte: endOfDay(endDate),
        },
      },
      orderBy: { date: 'asc' },
    });
  }

}
