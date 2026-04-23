/**
 * AI Tier Limits and Capability Mapping
 * NOTE: Monthly Credit Quotas are controlled by the PostgreSQL Database (Plan table),
 * NOT this file. This file only controls AI mechanical capabilities (models, output length).
 */

// ============================================================
// MODEL REGISTRY
// Currently deployed non-reasoning models on HF Router.
// Swap strings here if availability changes — nothing else needs to update.
// ============================================================
export const AI_MODELS = {
  // Fast & cheap — for captions, hashtags, simple rewrites
  FAST: 'meta-llama/Llama-3.3-70B-Instruct:novita',

  // Balanced — for variants, bulk generation, repurposing
  BALANCED: 'Qwen/Qwen2.5-72B-Instruct:novita',

  // Reasoning — only use when you actually need deep thinking
  // NOTE: Requires high maxTokens (4000+) because reasoning eats most of the budget
  REASONING: 'zai-org/GLM-4.6:novita',
} as const;

// ============================================================
// TIER CAPABILITIES
// Controls what each plan tier can do mechanically.
// Credit quotas live in the DB — this is only about capabilities.
// ============================================================
export const AI_TIER_LIMITS = {
  BUSINESS: {
    label: 'Business Plan',
    allowedModels: [AI_MODELS.FAST, AI_MODELS.BALANCED],
    maxVariants: 3,
    maxPlatforms: 4, // LI, X, FB, IG simultaneously
    brandKitDepth: 'FULL', // Tone + Formatting Rules + Guidelines
    maxOutputLength: 2000,
  },
  ROCKET: {
    label: 'Rocket Plan',
    allowedModels: [AI_MODELS.BALANCED, AI_MODELS.FAST, AI_MODELS.REASONING],
    maxVariants: 5,
    maxPlatforms: 10, // Unlimited multi-platform distribution
    brandKitDepth: 'STRICT', // Full enforcement + Banned keywords check
    maxOutputLength: 4000,
  },
  ENTERPRISE: {
    label: 'Enterprise Plan',
    allowedModels: [AI_MODELS.BALANCED, AI_MODELS.FAST, AI_MODELS.REASONING],
    maxVariants: 10,
    maxPlatforms: 99, // Truly unlimited
    brandKitDepth: 'STRICT',
    maxOutputLength: 8000, // Maximum context windows
  },
} as const;

// ============================================================
// FEATURE COSTS (in AI credits)
// ============================================================
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

// ============================================================
// TYPES
// ============================================================
export type PlanTier = keyof typeof AI_TIER_LIMITS;
export type TierConfig = (typeof AI_TIER_LIMITS)[PlanTier];
export type AiModel = (typeof AI_MODELS)[keyof typeof AI_MODELS];
