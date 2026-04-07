import { PlanFeatures } from '@/common/constants/billing.types';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FEATURE_KEY } from '../decorators/require-feature.decorator';

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFeature = this.reflector.getAllAndOverride<
      keyof PlanFeatures
    >(FEATURE_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredFeature) return true;

    const { user } = context.switchToHttp().getRequest();

    // Check directly against the user object (populated by AuthStrategy)
    if (!user.features || user.features[requiredFeature] !== true) {
      throw new ForbiddenException(`Upgrade required for ${requiredFeature}`);
    }

    return true;
  }
}
