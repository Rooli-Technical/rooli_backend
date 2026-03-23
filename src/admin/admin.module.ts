import { Module } from '@nestjs/common';
import { SupportTicketModule } from './support-ticket/support-ticket.module';
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

@Module({
  imports: [
    AdminAuthModule,       // ← registers AdminJwtStrategy + AdminGoogleStrategy with Passport
    SupportTicketModule,
  ],
  controllers: [
    AdminController,
    AdminOrganizationController,
    AdminUserController
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
    // AdminAuthService is provided + exported by AdminAuthModule — remove it from here
  ],
})
export class AdminModule {}