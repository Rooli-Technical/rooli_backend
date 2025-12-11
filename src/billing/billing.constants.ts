import { PlanTier } from '@generated/enums';
import { PlanConfig } from './types/billing.types';

// src/billing/billing.constants.ts
export const PLANS: Record<PlanTier, PlanConfig> = {
  FREE: {
    tier: 'FREE',
    name: 'Free',
    monthlyPrice: 0,
    yearlyPrice: 0,
    credits: 1000,
    maxMembers: 1,
    features: [
      'Basic scheduling',
      '1 social platform',
      '100 AI credits/month',
      'Basic analytics',
    ],
  },
  STARTER: {
    tier: 'STARTER',
    name: 'Starter',
    monthlyPrice: 29,
    yearlyPrice: 290, // $29 * 10 months
    credits: 10000,
    maxMembers: 3,
    features: [
      'All social platforms',
      '10,000 AI credits/month',
      'Up to 3 team members',
      'Advanced analytics',
      'Content templates',
    ],
  },
  PROFESSIONAL: {
    tier: 'PROFESSIONAL',
    name: 'Professional',
    monthlyPrice: 79,
    yearlyPrice: 790, // $79 * 10 months
    credits: 50000,
    maxMembers: 10,
    features: [
      '50,000 AI credits/month',
      'Up to 10 team members',
      'Priority support',
      'Custom branding',
      'API access',
    ],
  },
  ENTERPRISE: {
    tier: 'ENTERPRISE',
    name: 'Enterprise',
    monthlyPrice: 199,
    yearlyPrice: 1990, // $199 * 10 months
    credits: 200000,
    maxMembers: 50,
    features: [
      '200,000 AI credits/month',
      'Up to 50 team members',
      'Dedicated account manager',
      'Custom workflows',
      'SLA guarantee',
    ],
  },
  AGENCY: {
    tier: 'AGENCY',
    name: 'Agency',
    monthlyPrice: 499,
    yearlyPrice: 4990, // $499 * 10 months
    credits: 1000000,
    maxMembers: 200,
    features: [
      '1,000,000 AI credits/month',
      'Up to 200 team members',
      'Multi-client management',
      'White-label solutions',
      '24/7 premium support',
    ],
  }
};

export const CREDIT_COST = {
  AI_CONTENT: 1, // per 100 tokens
  AI_IMAGE: 5, // per image
  POST: 1, // per post
};
