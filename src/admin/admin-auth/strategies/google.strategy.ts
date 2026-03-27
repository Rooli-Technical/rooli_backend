import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminGoogleStrategy extends PassportStrategy(
  Strategy,
  'admin-google',
) {
  constructor(private configService: ConfigService) {
    super({
      clientID: configService.get('GOOGLE_ADMIN_CLIENT_ID'),
      clientSecret: configService.get('GOOGLE_ADMIN_CLIENT_SECRET'),
      callbackURL: configService.get('GOOGLE_ADMIN_CALLBACK_URL'),
      scope: ['email', 'profile'],
    });
  }

  async validate(accessToken: string, refreshToken: string, profile: any) {
    const { name, emails, photos } = profile;
    const email = emails[0].value;

    const allowedDomain = this.configService.get('ADMIN_EMAIL_DOMAIN');
    if (!email.endsWith(`@${allowedDomain}`)) {
      throw new UnauthorizedException('Unauthorized email domain');
    }

    return {
      email,
      firstName: name.givenName,
      lastName: name.familyName,
      picture: photos[0]?.value,
    };
  }
}
