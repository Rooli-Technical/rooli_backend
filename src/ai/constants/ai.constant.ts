/**
 * AI Tier Limits and Capability Mapping
 * NOTE: Monthly Credit Quotas are controlled by the PostgreSQL Database (Plan table), 
 * NOT this file. This file only controls AI mechanical capabilities (models, output length).
 */

export const AI_TIER_LIMITS = {
  BUSINESS: {
    label: 'Business Plan',
    maxVariants: 3,
    maxPlatforms: 4, // Can generate for LI, X, FB, and IG simultaneously
    allowedModels: ['meta-llama/Meta-Llama-3-8B-Instruct'], // Access to Pro for better quality
    brandKitDepth: 'FULL', // Tone + Formatting Rules + Guidelines
    maxOutputLength: 2000,
  },
  ROCKET: {
    label: 'Rocket Plan',
    maxVariants: 5,
    maxPlatforms: 10, // Unlimited multi-platform distribution
    allowedModels: ['nousresearch/hermes-2-pro-llama-3-8b'], // Top-tier models enabled
    brandKitDepth: 'STRICT', // Full enforcement + Banned keywords check
    maxOutputLength: 4000,
  },
  ENTERPRISE: {
    label: 'Enterprise Plan',
    maxVariants: 10,
    maxPlatforms: 99, // Truly unlimited
    allowedModels: ['nousresearch/hermes-2-pro-llama-3-8b'], // Premium models
    brandKitDepth: 'STRICT',
    maxOutputLength: 8000, // Maximum context windows
  },
} as const;

export const AI_COSTS: Record<string, number> = {
  CAPTION: 1, // Standard text generation
  VARIANTS: 2, // Multiple platform versions (slightly higher)
  REPURPOSE: 3, // Scraping + heavy transformation
  BULK: 15, // Generating 10-30 posts at once
  IMAGE: 10, // GPU-intensive image generation
  HASHTAGS: 1, // Lightweight list generation
  OPTIMIZE: 1, // Quick rewrite/edit
  HOLIDAY_POST: 1, // Specific holiday generation
};

// Helper Types derived from the constant
export type PlanTier = keyof typeof AI_TIER_LIMITS;
export type TierConfig = (typeof AI_TIER_LIMITS)[PlanTier];
