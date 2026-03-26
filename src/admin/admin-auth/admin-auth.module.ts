import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { AdminAuthService } from './admin-auth.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminJwtStrategy } from './strategies/jwt.strategy';
import { AdminJwtGuard } from '../guards/admin-jwt.guard';

// ⚠️  AdminGoogleStrategy removed until these are set in .env:
//     GOOGLE_ADMIN_CLIENT_ID
//     GOOGLE_ADMIN_CLIENT_SECRET
//     GOOGLE_ADMIN_CALLBACK_URL

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    // Empty register — AdminAuthService calls signAsync with secret explicitly
    // so no default secret is needed here
    JwtModule.register({}),
  ],
  controllers: [AdminAuthController],
  providers: [
    PrismaService,
    AdminAuthService,
    AdminJwtStrategy, // registers 'admin-jwt' with Passport
    AdminJwtGuard,
  ],
  exports: [
    JwtModule,
    AdminAuthService,
    AdminJwtGuard,
  ],
})
export class AdminAuthModule {}