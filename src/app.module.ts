import * as Joi from 'joi';

import { BullModule } from '@nestjs/bullmq';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

/// MODULES
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { RoomsModule } from './rooms/rooms.module';
import { GatewayModule } from './gateway/gateway.module';
import { UsersModule } from './users/users.module';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 20 }],
    }),
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      envFilePath: `.env`,
      expandVariables: true,
      validationSchema: Joi.object({
        REDIS_URL: Joi.string().required(),
        AUTH_GOOGLE_ID: Joi.string().required(),
        AUTH_GOOGLE_SECRET: Joi.string().required(),
        PORT: Joi.string().required(),
        AES_KEY: Joi.string().required(),
        JWT_SECRET: Joi.string().required(),
        JWT_SECRET_EXPIRATION: Joi.string().required(),
        OPENAI_API_KEY: Joi.string().required(),
        DATABASE_URL: Joi.string().required(),
        NEXT_PUBLIC_APP_URL: Joi.string().required(),
        CLOUDINARY_URL: Joi.string().required(),
        CLOUDINARY_SIGNATURE_EXPIRATION: Joi.string().required(),
      }),
    }),
    PinoLoggerModule.forRoot({
      pinoHttp: {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            messageFormat:
              '{req.method} {req.url} {res.statusCode} - {responseTime}ms',
          },
        },
        autoLogging: true,
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      },
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        return {
          connection: {
            url: configService.getOrThrow('REDIS_URL'),
          },
        };
      },
    }),

    CommonModule,

    /// APP MODULES
    AuthModule,
    RoomsModule,
    GatewayModule,
    UsersModule,
    VoiceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: false }),
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
