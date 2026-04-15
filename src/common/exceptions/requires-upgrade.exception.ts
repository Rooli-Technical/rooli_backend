import { HttpException, HttpStatus } from '@nestjs/common';

export class RequiresUpgradeException extends HttpException {
  constructor(featureName: string, customMessage?: string) {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        errorCode: 'UPGRADE_REQUIRED', // 🚨 The magic key stays the same!
        feature: featureName,
        message: customMessage || `Your current plan does not include access to ${featureName}. Please upgrade to unlock it.`,
        requiresUpgrade: true,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}