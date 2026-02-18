import { Controller, Get, Param, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { PermissionResource, PermissionAction } from '@generated/enums';
import { ListAuditLogsDto } from './dtos/list-audit-logs.dto';

@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

   @Get()
  @RequirePermission(PermissionResource.AUDIT_LOGS, PermissionAction.READ )
  list(
    @Param('organizationId') organizationId: string,
    @Query() query: ListAuditLogsDto,
  ) {
    return this.auditService.listOrganizationLogs({ organizationId, query });
  }
}
