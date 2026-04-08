import { Prisma } from "@generated/client";

export type PlanTier = 'BUSINESS' | 'ROCKET' | 'ENTERPRISE'; // Or import from your enums
export type Platform = 'FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN' | 'TWITTER' | 'TIKTOK';

export interface UpdatePlanInput {
  // Pricing
  monthlyPriceNgn?: number;
  annualPriceNgn?: number;
  monthlyPriceUsd?: number;
  annualPriceUsd?: number;
  
  // Core Limits
  maxWorkspaces?: number;
  maxSocialProfiles?: number; // 🚨 Renamed
  maxUsers?: number;          // 🚨 Renamed
  
  // AI Limits & Enterprise Overage
  aiCreditsMonthly?: number;  // 🚨 Renamed
  aiOverageRateCents?: number; // 🚀 New
  aiOverageCapCents?: number | null; // 🚀 New
  
  // Feature Flags
  features?: Prisma.JsonObject | Record<string, any>; //
  allowedPlatforms?: Platform[]; // 🚀 New
  
  isActive?: boolean;
}

export interface CreatePlanInput {
  name: string;
  description?: string;
  tier: PlanTier;
  
  // Pricing (Aligned with your seed script which stores both in one row!)
  monthlyPriceNgn: number;
  annualPriceNgn: number;
  monthlyPriceUsd: number;
  annualPriceUsd: number;
  
  // Core Limits
  maxWorkspaces?: number;
  maxSocialProfiles?: number;
  maxUsers?: number;
  
  // AI Limits & Enterprise Overage
  aiCreditsMonthly?: number;
  aiOverageRateCents?: number;
  aiOverageCapCents?: number | null;
  
  // Feature Flags
  features?: Prisma.JsonObject | Record<string, any>;
  allowedPlatforms?: Platform[];

  // Paystack Codes
  paystackPlanCodeMonthlyNgn?: string;
  paystackPlanCodeAnnualNgn?: string;
  paystackPlanCodeMonthlyUsd?: string;
  paystackPlanCodeAnnualUsd?: string;
}

export interface GetPaymentsInput {
  search?: string;
  page?: number;
  limit?: number;
}

export type OverrideType = 'extend_trial' | 'custom_end_date';

export interface ManualOverrideInput {
  organizationId: string;
  overrideType: OverrideType;
  /** Only required when overrideType === "custom_end_date" */
  customEndDate?: Date;
}