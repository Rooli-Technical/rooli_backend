import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Extracts the User object from the Request.
 * Populated by JwtAuthGuard and ContextGuard.
 * * Usage:
 * @User() user: any            -> Returns entire user object
 * @User('id') userId: string   -> Returns just the ID
 * @User('organizationId') orgId: string -> Returns the Org ID from Context
 */
export const CurrentUser = createParamDecorator(
  (data: string, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;

    // Safety check: if guard failed or public route, user might be undefined
    if (!user) return null;

    return data ? user[data] : user;
  },
);
