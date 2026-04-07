import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { InvitationsController } from './invitations/controllers/invitations.controller';
import { InvitationsService } from './invitations/invitations.service';
//import { AccessControlModule } from '@/access-control/access-control.module';
import { BillingModule } from '@/billing/billing.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { OrganizationMemberService } from './organization-member/organization-member.service';

@Module({
  imports: [
    BillingModule,
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
  controllers: [OrganizationsController, InvitationsController],
  providers: [
    OrganizationsService,
    InvitationsService,
    JwtService,
    OrganizationMemberService,
  ],
})
export class OrganizationsModule {}
