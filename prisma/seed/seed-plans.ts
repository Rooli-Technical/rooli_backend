import {
  PlanTier,
  Platform,
} from '../../generated/prisma/client';
import { prisma } from './utils';


export async function seedPlans() {
  const plans = [
    {
      name: 'Business',
      description: 'For growing businesses & small teams',
      tier: PlanTier.BUSINESS,
      badge: 'Most Popular',

      monthlyPriceUsd: 1200,
      annualPriceUsd: 9600,
      monthlyPriceNgn: 1764000,
      annualPriceNgn: 14112000,

      paystackPlanCodeMonthlyNgn: 'PLN_y8l5ovjzqx6bo5j',
      paystackPlanCodeAnnualNgn: 'PLN_j2dz1p5g4zima6a',
      paystackPlanCodeMonthlyUsd: 'DUMMY_USD_BUSINESS_MONTHLY',
      paystackPlanCodeAnnualUsd: 'DUMMY_USD_BUSINESS_ANNUAL',

      maxWorkspaces: 1,
      maxSocialProfiles: 4,
      maxUsers: 3,

      aiCreditsMonthly: 30,
      aiOverageRateCents: 2,
      aiOverageCapCents: 2000,

      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER', 'TIKTOK'] as Platform[],

      features: {
        analytics: 'basic',
        bulkScheduling: true,
        postApprovals: true,
        repurposeContent: true,
      },

      isActive: true,
    },

    {
      name: 'Rocket',
      description: 'Best for agencies & growing teams',
      tier: PlanTier.ROCKET,
      badge: 'Best for Agencies',

      monthlyPriceUsd: 4900,
      annualPriceUsd: 47000,
      monthlyPriceNgn: 7203000,
      annualPriceNgn: 69090000,

      paystackPlanCodeMonthlyNgn: 'PLN_of4tu83cw2og4s5',
      paystackPlanCodeAnnualNgn: 'PLN_oiwln4pt1wxbw61',
      paystackPlanCodeMonthlyUsd: 'DUMMY_USD_ROCKET_MONTHLY',
      paystackPlanCodeAnnualUsd: 'DUMMY_USD_ROCKET_ANNUAL',

      maxWorkspaces: 5,
      maxSocialProfiles: 20,
      maxUsers: 9999,

      aiCreditsMonthly: 100,
      aiOverageRateCents: 2,
      aiOverageCapCents: 5000,

      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER', 'TIKTOK'] as Platform[],

      features: {
        analytics: 'advanced',
        bulkScheduling: true,
        postApprovals: true,
        bulkAI: true,
        whiteLabelReports: true,
        clientPortal: true,
        prioritySupport: true,
        repurposeContent: true,
      },

      isActive: true,
    },

    {
      name: 'Enterprise',
      description: 'Custom solutions for large organizations',
      tier: PlanTier.ENTERPRISE,

      monthlyPriceUsd: 20000,
      annualPriceUsd: 240000,
      monthlyPriceNgn: 29400000,
      annualPriceNgn: 352800000,

      paystackPlanCodeMonthlyNgn: 'MANUAL',
      paystackPlanCodeAnnualNgn: 'MANUAL',
      paystackPlanCodeMonthlyUsd: 'MANUAL',
      paystackPlanCodeAnnualUsd: 'MANUAL',

      maxWorkspaces: 9999,
      maxSocialProfiles: 9999,
      maxUsers: 9999,

      aiCreditsMonthly: 999999,
      aiOverageRateCents: 0,
      aiOverageCapCents: null,

      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER', 'TIKTOK'] as Platform[],

      features: {
        analytics: 'advanced',
        bulkScheduling: true,
        postApprovals: true,
        bulkAI: true,
        whiteLabelReports: true,
        clientPortal: true,
        campaignPlanning: true,
        prioritySupport: true,
        repurposeContent: true,
        sla: true,
      },

      isActive: false,
    },
  ];

  await prisma.$transaction(async (tx) => {
    for (const plan of plans) {
      await tx.plan.upsert({
        where: { tier: plan.tier },
        update: plan,
        create: plan,
      });
    }
  });

  console.log('V2 Pricing Plans seeded successfully');
}