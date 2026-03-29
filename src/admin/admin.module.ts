import { Module } from '@nestjs/common';
import { AdminAuthModule } from './admin-auth/admin-auth.module';
import { PrismaService } from '@/prisma/prisma.service';

import { AdminController } from './admin-controller';

import { AdminDashboardRepository } from './dashboard/admin-dashboard.repository';
import { AdminDashboardService } from './dashboard/admin-dashboard.service';

import { AdminUserRepository } from './users/admin.user.repository';
import { AdminUserService } from './users/admin.user.service';

import { AdminOrganizationRepository } from './organization/admin-organization.repository';
import { AdminOrganizationService } from './organization/admin-organization.service';
import { AdminOrganizationController } from './organization/admin-organization.controller';
import { AdminUserController } from './users/admin-user.controller';
import { AdminSecurityController } from './security/admin-security.controller';
import { AdminSecurityService } from './security/admin-security.service';
import { AdminSecurityRepo } from './security/admin-security.repo';
import { AdminBillingController } from './billing/admin-billings.controller';
import { AdminBillingService } from './billing/admin-biilings.service';
import { TicketsController } from './support-ticket/support-ticket.controller';
import { TicketsService } from './support-ticket/support-ticket.service';
import { TicketsRepository } from './support-ticket/support-ticket.repository';
import { DomainEventsService } from '@/events/domain-events.service';
// import { SupportTicketModule } from './support-ticket/support-ticket.module';

@Module({
  imports: [
    AdminAuthModule, // ← registers AdminJwtStrategy + AdminGoogleStrategy with Passport
    // SupportTicketModule,
  ],
  controllers: [
    AdminController,
    AdminOrganizationController,
    AdminUserController,
    AdminSecurityController,
    AdminBillingController,
    TicketsController
    // AdminAuthController is declared inside AdminAuthModule — remove it from here
  ],
  providers: [
    PrismaService,
    AdminDashboardRepository,
    AdminDashboardService,
    AdminUserRepository,
    AdminUserService,
    AdminOrganizationRepository,
    AdminOrganizationService,
    AdminSecurityService,
    AdminSecurityRepo,
    AdminBillingService,
    TicketsService,
    TicketsRepository,
    DomainEventsService
    // AdminAuthService is provided + exported by AdminAuthModule — remove it from here
  ],
})
export class AdminModule {}
