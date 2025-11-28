import { Permission } from "@generated/client";
import { RoleScope } from "@generated/enums";

export interface RoleWithPermissions {
  id: string;
  name: string;
  description?: string;
  displayName: string;
  scope: RoleScope;
  isSystem: boolean;
  isDefault: boolean;
  organizationId?: string;
  permissions: Permission[];
}