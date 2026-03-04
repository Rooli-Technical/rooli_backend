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

  async saveAccountAnalytics(payload: { baseData: any; specificKey: string; specificData: any }) {
    const { baseData, specificKey, specificData } = payload;
    const dateKey = startOfDay(new Date(baseData.date));

    // Prisma nested upsert logic
    const nestedWrite = {
      upsert: {
        create: specificData,
        update: specificData,
      },
    };

    return this.prisma.accountAnalytics.upsert({
      where: {
        socialProfileId_date: {
          socialProfileId: baseData.socialProfileId,
          date: dateKey,
        },
      },
      create: {
        ...baseData,
        date: dateKey,
        // E.g., linkedInStats: { create: { demographics: {...} } }
        [specificKey]: { create: specificData }, 
      },
      update: {
        ...baseData,
        date: dateKey,
        updatedAt: new Date(),
        // E.g., linkedInStats: { upsert: { create: {...}, update: {...} } }
        [specificKey]: nestedWrite,
      },
    });
  }

  async savePostSnapshot(payload: { baseData: any; specificKey: string; specificData: any }) {
    const { baseData, specificKey, specificData } = payload;
    const dateKey = startOfDay(new Date(baseData.day));

    const nestedWrite = {
      upsert: {
        create: specificData,
        update: specificData,
      },
    };

    return this.prisma.postAnalyticsSnapshot.upsert({
      where: {
        postDestinationId_day: {
          postDestinationId: baseData.postDestinationId,
          day: dateKey,
        },
      },
      create: {
        ...baseData,
        day: dateKey,
        [specificKey]: { create: specificData },
      },
      update: {
        ...baseData,
        day: dateKey,
        fetchedAt: new Date(),
        [specificKey]: nestedWrite,
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
