import { Injectable, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_ADMIN_ROUTE_KEY } from '../decorators/admin-route.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();

    //  Check if this is an Admin Route
    const isAdminRoute = this.reflector.getAllAndOverride<boolean>(
      IS_ADMIN_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // This wasn't working even though the metadata was set, isAdminRoute still returns undefined
    // if (isAdminRoute) {
    //   return true; // Bypass the normal User JWT Strategy completely
    // }

    // if (request.path.startsWith('/api/v1/admin')) {
    //   console.log('Admin route detected by path — bypassing JwtAuthGuard');
    //   return true;
    // }

    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
