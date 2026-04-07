// src/common/utils/brand-kit-validator.util.ts
export class BrandKitValidator {
  static validateColors(colors: any): boolean {
    if (!colors || typeof colors !== 'object') return false;

    const validColorKeys = [
      'primary',
      'secondary',
      'accent',
      'background',
      'text',
    ];
    const colorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;

    return Object.entries(colors).every(
      ([key, value]) =>
        validColorKeys.includes(key) && colorRegex.test(value as string),
    );
  }

  static validateSocialHandles(handles: any): boolean {
    if (!handles || typeof handles !== 'object') return false;

    const validPlatforms = [
      'twitter',
      'linkedin',
      'facebook',
      'instagram',
      'youtube',
      'tiktok',
    ];

    return Object.entries(handles).every(
      ([platform, handle]) =>
        validPlatforms.includes(platform) && typeof handle === 'string',
    );
  }
}
