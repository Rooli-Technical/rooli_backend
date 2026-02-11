/**
 * AI Tier Limits and Capability Mapping for Rooli
 * This serves as the single source of truth for feature gating and quota management.
 */

export const AI_TIER_LIMITS = {
  CREATOR: {
    label: 'Creator Plan',
    monthlyCredits: 100,
    monthlyLimit: 50,           // Total AI generations per month
    maxVariants: 1,            // Number of versions for one prompt
    maxPlatforms: 1,           // Can only generate for one platform at a time
    allowedModels: ['mistralai/Mistral-7B-Instruct-v0.3'], // Fast, efficient model
    brandKitDepth: 'BASIC',    // Uses Tone only, ignores complex guidelines
    canRepurpose: false,       // Cannot turn URL/Video into posts
    canBulk: false,            // No batch generation
    maxOutputLength: 500,      // Character limit for AI response
  },
  BUSINESS: {
    label: 'Business Plan',
    monthlyLimit: 500,
    monthlyCredits: 1000,
    maxVariants: 3,
    maxPlatforms: 4,           // Can generate for LI, X, FB, and IG simultaneously
    allowedModels: ['meta-llama/Meta-Llama-3-8B-Instruct'], // Access to Pro for better quality
    brandKitDepth: 'FULL',     // Tone + Formatting Rules + Guidelines
    canRepurpose: true,        // Blog-to-post enabled
    canBulk: false,            // Restricted to one-off or small sets
    maxOutputLength: 2000,
  },
  ROCKET: {
    label: 'Rocket Plan',
    monthlyLimit: 5000,        // High-volume for agencies
    monthlyCredits: 5000,
    maxVariants: 5,
    maxPlatforms: 10,          // Unlimited multi-platform distribution
    allowedModels: ['nousresearch/hermes-2-pro-llama-3-8b'], // Top-tier models enabled
    brandKitDepth: 'STRICT',   // Full enforcement + Banned keywords check
    canRepurpose: true,
    canBulk: true,             // 30-day content calendar generation enabled
    maxOutputLength: 4000,
  },
} as const;

export const AI_COSTS: Record<string, number> = {
  CAPTION: 1,        // Standard text generation
  VARIANTS: 2,       // Multiple platform versions (slightly higher)
  REPURPOSE: 3,      // Scraping + heavy transformation
  BULK: 15,          // Generating 10-30 posts at once
  IMAGE: 10,         // GPU-intensive image generation
  HASHTAGS: 1,       // Lightweight list generation
  OPTIMIZE: 1,       // Quick rewrite/edit
  HOLIDAY_POST: 1,   // Specific holiday generation
};

// Helper Types derived from the constant
export type PlanTier = keyof typeof AI_TIER_LIMITS;
export type TierConfig = typeof AI_TIER_LIMITS[PlanTier];
