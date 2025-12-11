import { Module } from '@nestjs/common';
import { AccessControlService } from './access-control.service';
import { AccessControlController } from './access-control.controller';
import { PermissionController } from './controller/permission.controller';
import { PermissionService } from './services/permissions.service';
import { RoleService } from './services/roles.service';
import { RoleController } from './controller/role.controller';

@Module({
  controllers: [AccessControlController, RoleController, PermissionController],
  providers: [AccessControlService, RoleService, PermissionService],
  exports: [RoleService]
})
export class AccessControlModule {}
