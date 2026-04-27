import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { InvitationsController } from './invitations/controllers/invitations.controller';
import { InvitationsService } from './invitations/invitations.service';
import { BillingModule } from '@/billing/billing.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { OrganizationMemberService } from './organization-member/organization-member.service';
import { PlanAccessService } from '@/plan-access/plan-access.service';
import { PlanAccessModule } from '@/plan-access/plan-access.module';
import { PublicInvitationsController } from './invitations/controllers/public-invitation.controller';

@Module({
  imports: [
    BillingModule,
    PlanAccessModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRES_IN'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [OrganizationsController, InvitationsController, PublicInvitationsController],
  providers: [
    OrganizationsService,
    InvitationsService,
    JwtService,
    OrganizationMemberService,
  ],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
