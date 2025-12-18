
import { Prisma } from '../../generated/prisma/client';
import { prisma } from './utils';

export async function seedPlans() {
  const plans: Prisma.PlanCreateInput[] = [
    //  STARTER
    {
      name: 'Starter',
      description: 'For freelancers and solopreneurs',
      flutterwavePlanId: '228186',
      price: new Prisma.Decimal(27705.61),
      currency: 'NGN',
      interval: 'monthly',
      maxTeamMembers: 1,
      maxSocialAccounts: 5,
      maxPostsPerMonth: 200,
      features: {
        teamFeatures: false,
        approvalWorkflows: false,
        analytics: true,
        aiCaptions: true,
      },
      isActive: true,
    },

    // GROWTH
    {
      name: 'Growth',
      description: 'For small teams and growing businesses',
      flutterwavePlanId: '228187',
      price: new Prisma.Decimal(73500),
      currency: 'NGN',
      interval: 'monthly',
      maxTeamMembers: 5,
      maxSocialAccounts: 15,
      maxPostsPerMonth: 800,
      features: {
        teamFeatures: true,
        collaboratorRoles: true,
        approvalWorkflows: true,
        analytics: true,
        aiCaptions: true,
      },
      isActive: true,
    },

    // AGENCY
    {
      name: 'Agency',
      description: 'For agencies managing multiple brands',
      flutterwavePlanId: '228188',
      price: new Prisma.Decimal(223500), 
      currency: 'NGN',
      interval: 'monthly',
      maxTeamMembers: 15,
      maxSocialAccounts: 30,
      maxPostsPerMonth: 3000,
      features: {
        teamFeatures: true,
        collaboratorRoles: true,
        approvalWorkflows: true,
        clientReporting: true,
        whiteLabel: false,
        prioritySupport: true,
      },
      isActive: true,
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { flutterwavePlanId: plan.flutterwavePlanId },
      update: plan,
      create: plan,
    });
  }

  console.log('✅ Plans seeded successfully');
}