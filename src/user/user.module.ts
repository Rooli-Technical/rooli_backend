import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { BillingModule } from '@/billing/billing.module';
import { OrganizationsModule } from '@/organizations/organizations.module';

@Module({
  imports: [BillingModule, OrganizationsModule],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
