import { Module } from '@nestjs/common';
import { RoleController } from './rbac.controller';
import { RoleService } from './rbac.service';


@Module({
  controllers: [RoleController],
  providers: [RoleService],
})
export class RbacModule {}
