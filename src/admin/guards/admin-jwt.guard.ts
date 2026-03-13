import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class AdminJwtGuard extends AuthGuard('admin-jwt') {
  canActivate(context: ExecutionContext) {
    // Add any custom pre-flight logic here if needed
    return super.canActivate(context);
  }

  handleRequest(err, user, info) {
    // You can throw custom exceptions here if the admin token is invalid
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid Admin Credentials');
    }
    return user;
  }
}