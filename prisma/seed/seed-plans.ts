import {
  BillingInterval,
  PlanTier,
  Prisma,
} from '../../generated/prisma/client';
import { prisma } from './utils';

export async function seedPlans() {
  const plans: Prisma.PlanCreateInput[] = [
    // ======================
    // CREATOR
    //======================
    {
      name: 'Creator Monthly',
      description: 'For creators, solo founders, freelancers & small brands.',
      tier: PlanTier.CREATOR,

      priceNgn: 7350,
      priceUsd: 5,

      interval: BillingInterval.MONTHLY,

      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'],

      maxWorkspaces: 1,
      maxSocialProfilesPerWorkspace: 3,
      maxTeamMembers: 1,
      monthlyAiCredits: 50,

      features: {
        canRemoveBranding: false,
        advancedAnalytics: false,
        mediaLibrary: true,
      },

      isActive: true,

      // NGN = REAL
      paystackPlanCodeNgn: 'PLN_u9jzjn5g3as3wk8',

      // USD = DUMMY (UI ONLY)
      paystackPlanCodeUsd: 'DUMMY_USD_CREATOR_MONTHLY',
    },

    {
      name: 'Creator Annual',
      description: 'Annual - For creators & freelancers.',
      tier: PlanTier.CREATOR,

      priceNgn: 83790,
      priceUsd: 57,

      interval: BillingInterval.YEARLY,

      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'],

      maxWorkspaces: 1,
      maxSocialProfilesPerWorkspace: 3,
      maxTeamMembers: 1,
      monthlyAiCredits: 50,

      features: {
        canRemoveBranding: false,
        advancedAnalytics: false,
        mediaLibrary: true,
      },

      isActive: true,

      paystackPlanCodeNgn: 'PLN_tf507aah9h9a3tf',
      paystackPlanCodeUsd: 'DUMMY_USD_CREATOR_ANNUAL',
    },

    // // ======================
    // // BUSINESS
    // // ======================
    {
      name: 'Business Monthly',
      description: 'For growing businesses & small teams.',
      tier: PlanTier.BUSINESS,
      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER'],

      priceNgn: 14700,
      priceUsd: 10,

      interval: BillingInterval.MONTHLY,

      maxWorkspaces: 1,
      maxSocialProfilesPerWorkspace: 4,
      maxTeamMembers: 3,
      monthlyAiCredits: 1000,

      features: {
        canRemoveBranding: true,
        advancedAnalytics: true,
        approvalWorkflow: true,
        bulkScheduling: true,
      },

      isActive: true,

      paystackPlanCodeNgn: 'PLN_y8l5ovjzqx6bo5j',
      paystackPlanCodeUsd: 'DUMMY_USD_BUSINESS_MONTHLY',
    },

    {
      name: 'Business Annual',
      description: 'Annual - For growing businesses.',
      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER'],
      tier: PlanTier.BUSINESS,

      priceNgn: 167580,
      priceUsd: 114,

      interval: BillingInterval.YEARLY,

      maxWorkspaces: 1,
      maxSocialProfilesPerWorkspace: 4,
      maxTeamMembers: 3,
      monthlyAiCredits: 1000,

      features: {
        canRemoveBranding: true,
        advancedAnalytics: true,
        approvalWorkflow: true,
        bulkScheduling: true,
      },

      isActive: true,

      paystackPlanCodeNgn: 'PLN_j2dz1p5g4zima6a',
      paystackPlanCodeUsd: 'DUMMY_USD_BUSINESS_ANNUAL',
    },

    // // ======================
    // // ROCKET
    // // ======================
    {
      name: 'Rocket Monthly',
      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER'],
      description: 'For agencies & large teams.',
      tier: PlanTier.ROCKET,

      priceNgn: 44100,
      priceUsd: 30,

      interval: BillingInterval.MONTHLY,

      maxWorkspaces: 5,
      maxSocialProfilesPerWorkspace: 4,
      maxTeamMembers: 9999,
      monthlyAiCredits: 5000,

      features: {
        canRemoveBranding: true,
        advancedAnalytics: true,
        approvalWorkflow: true,
        whiteLabelReports: true,
        prioritySupport: true,
      },

      isActive: true,

      paystackPlanCodeNgn: 'PLN_of4tu83cw2og4s5',
      paystackPlanCodeUsd: 'DUMMY_USD_ROCKET_MONTHLY',
    },

    {
      name: 'Rocket Annual',
      description: 'Annual - For agencies & companies.',
      tier: PlanTier.ROCKET,
      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER'],

      priceNgn: 502740,
      priceUsd: 342,

      interval: BillingInterval.YEARLY,

      maxWorkspaces: 5,
      maxSocialProfilesPerWorkspace: 4,
      maxTeamMembers: 9999,
      monthlyAiCredits: 5000,

      features: {
        canRemoveBranding: true,
        advancedAnalytics: true,
        approvalWorkflow: true,
        whiteLabelReports: true,
        prioritySupport: true,
      },

      isActive: true,

      paystackPlanCodeNgn: 'PLN_oiwln4pt1wxbw61',
      paystackPlanCodeUsd: 'DUMMY_USD_ROCKET_ANNUAL',
    },

  
   // ======================
    // ENTERPRISE (Contact Sales)
    // ======================
    {
      name: 'Enterprise', 
      description: 'Custom solutions for large organizations.',
      tier: PlanTier.ENTERPRISE,
      
      // Price is just a placeholder/baseline. 
      // In reality, you charge what you negotiate.
      priceNgn: 294000, 
      priceUsd: 200,
      
      interval: BillingInterval.MONTHLY, // Default to monthly for system calculation

      allowedPlatforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER'],
      
      // "Custom" means you likely manually edit these per org, 
      // but these serve as the high defaults:
      maxWorkspaces: 9999, // Unlimited
      maxSocialProfilesPerWorkspace: 9999, // Unlimited
      maxTeamMembers: 9999, // Unlimited
      monthlyAiCredits: 999999, // Effectively Unlimited
      
      features: {
        canRemoveBranding: true,
        advancedAnalytics: true,
        approvalWorkflow: true,
        whiteLabelReports: true,
        prioritySupport: true,
        dedicatedAccountManager: true,
        sla: true,
        customIntegrations: true,
      },
      
      // HIDDEN FROM PUBLIC UI
      // Use this flag in your frontend to show a "Contact Sales" button instead of "Subscribe"
      isActive: false, 
      
      // No automatic billing
      paystackPlanCodeNgn: 'MANUAL_BILLING',
      paystackPlanCodeUsd: 'MANUAL_BILLING',
    }
  ];

  await prisma.$transaction(async (tx) => {
    for (const plan of plans) {
      await tx.plan.upsert({
        where: { name: plan.name },
        update: plan,
        create: plan,
      });
    }
  });

  console.log('Plans seeded successfully');
}
