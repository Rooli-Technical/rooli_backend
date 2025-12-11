import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { MembersController } from './members/members.controller';
import { InvitationsController } from './invitations/invitations.controller';
import { InvitationsService } from './invitations/invitations.service';
import { MembersService } from './members/members.service';
import { AccessControlModule } from '@/access-control/access-control.module';

@Module({
  imports: [AccessControlModule],
  controllers: [
    OrganizationsController,
    MembersController,
    InvitationsController,
  ],
  providers: [OrganizationsService, MembersService, InvitationsService],
})
export class OrganizationsModule {}
