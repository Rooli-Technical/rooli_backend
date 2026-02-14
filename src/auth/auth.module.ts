import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtStrategy } from './strategies/jwt.strategy';
import { MailService } from '@/mail/mail.service';
import { PrismaService } from '@/prisma/prisma.service';
import { GoogleStrategy } from './strategies/google.strategy';
import { BillingModule } from '@/billing/billing.module';

@Module({
  imports: [
    BillingModule,
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRES_IN'),
        },
      }),
      inject: [ConfigService],
    }),
ThrottlerModule.forRoot({
  throttlers: [
    {
      ttl: 60,
      limit: 20,
    },
  ],
}),
  ],
  controllers: [AuthController],
   providers: [
    AuthService,
    PrismaService,
    MailService,
    JwtStrategy,
    JwtService,
    GoogleStrategy
  ],
  exports:[JwtService, AuthService]
})
export class AuthModule {}
