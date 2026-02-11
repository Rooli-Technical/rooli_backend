// src/common/constants/tier-limits.ts
// Central place for plan limits (use in QueueSlots, AI quotas, team limits, etc.)

export type PlanTier = 'CREATOR' | 'BUSINESS' | 'ROCKET' | 'ENTERPRISE';

export type TierLimits = {
  // --- Queue / Scheduling
  maxQueueSlots: number;          // how many queue slots per workspace
  maxAutoScheduleDays: number;    // how far ahead queue engine can look
  maxBulkPostsPerRequest: number; // safety + abuse prevention

  // --- Workspaces / Profiles / Team
  maxWorkspaces: number;          // per org (ROCKET example: 5)
  maxSocialProfiles: number;      // per workspace (example: 4)
  maxTeamMembers: number;         // per org/workspace (depending on your design)

  // --- AI (if you want to keep it here)
  aiMonthlyGenerations: number;   // total AI calls/month
  aiMaxVariants: number;          // variants per prompt
  aiMaxPlatformsAtOnce: number;   // multi-platform generation
  aiMaxOutputLength: number;      // chars
};

export const TIER_LIMITS: Record<PlanTier, TierLimits> = {
  CREATOR: {
    // Queue
    maxQueueSlots: 10,          // enough for a simple weekly schedule
    maxAutoScheduleDays: 30,
    maxBulkPostsPerRequest: 20,

    // Product
    maxWorkspaces: 1,
    maxSocialProfiles: 3,
    maxTeamMembers: 1,

    // AI
    aiMonthlyGenerations: 50,
    aiMaxVariants: 1,
    aiMaxPlatformsAtOnce: 1,
    aiMaxOutputLength: 500,
  },

  BUSINESS: {
    maxQueueSlots: 50,
    maxAutoScheduleDays: 60,
    maxBulkPostsPerRequest: 100,

    maxWorkspaces: 1,
    maxSocialProfiles: 4,
    maxTeamMembers: 3,

    aiMonthlyGenerations: 500,
    aiMaxVariants: 3,
    aiMaxPlatformsAtOnce: 4,
    aiMaxOutputLength: 2000,
  },

  ROCKET: {
    maxQueueSlots: 200,
    maxAutoScheduleDays: 90,
    maxBulkPostsPerRequest: 500,

    maxWorkspaces: 5,
    maxSocialProfiles: 4, // per workspace => 20 total possible
    maxTeamMembers: 9999, // "unlimited"

    aiMonthlyGenerations: 5000,
    aiMaxVariants: 5,
    aiMaxPlatformsAtOnce: 10,
    aiMaxOutputLength: 4000,
  },

  ENTERPRISE: {
    // Enterprise is typically “custom” — set high defaults, override per org in DB
    maxQueueSlots: 1000,
    maxAutoScheduleDays: 180,
    maxBulkPostsPerRequest: 2000,

    maxWorkspaces: 9999,
    maxSocialProfiles: 9999,
    maxTeamMembers: 9999,

    aiMonthlyGenerations: 50000,
    aiMaxVariants: 10,
    aiMaxPlatformsAtOnce: 20,
    aiMaxOutputLength: 8000,
  },
} as const;
