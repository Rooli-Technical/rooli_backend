import { SetMetadata } from '@nestjs/common';

export const IS_ADMIN_ROUTE_KEY = 'isAdminRoute';
export const AdminRoute = () => SetMetadata(IS_ADMIN_ROUTE_KEY, true);
