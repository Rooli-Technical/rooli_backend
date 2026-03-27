import { PlanFeatures } from '@/common/constants/billing.types';
import { SetMetadata } from '@nestjs/common';

export const FEATURE_KEY = 'required_feature';

export const RequireFeature = (feature: keyof PlanFeatures) =>
  SetMetadata(FEATURE_KEY, feature);
