import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { WsJwtGuard } from './guards/ws-jwt.guard';

@Global()
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow('JWT_SECRET'),
        signOptions: { expiresIn: config.getOrThrow('JWT_SECRET_EXPIRATION') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    GoogleStrategy,
    JwtAuthGuard,
    WsJwtGuard,
  ],
  exports: [AuthService, JwtAuthGuard, WsJwtGuard, JwtModule],
})
export class AuthModule {}
