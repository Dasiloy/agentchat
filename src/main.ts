import 'dotenv/config';
import { join } from 'path';

import helmet from 'helmet';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const logger = new Logger('API_GATEWAY');
  const configService = app.get<ConfigService>(ConfigService);

  // Serve test client at /
  app.useStaticAssets(join(process.cwd(), 'test-client'));

  /// MIDDLEWARES
  app.enableCors({
    origin: [
      configService.get('NEXT_PUBLIC_APP_URL')!,
      `http://localhost:${configService.get('PORT')}`,
    ],
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  });

  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: [`'self'`],
          imgSrc: [`'self'`, 'data:', 'https:'],
          scriptSrc: [`'self'`, `'unsafe-inline'`, 'https://cdn.socket.io'],
          connectSrc: [`'self'`, 'ws:', 'wss:'],
          styleSrc: [`'self'`, `'unsafe-inline'`],
        },
      },
    }),
  );

  /// ROUTE PREFIX
  app.setGlobalPrefix('api', {
    exclude: ['/health', '/docs'],
  });

  /// SWAGGER
  const swaggerDoc = new DocumentBuilder()
    .setTitle('Agentchat API Docs')
    .setDescription(
      'API documentation for Agentchat, a collaborative chat backend with on-demand AI assistant.\n',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerDoc);
  SwaggerModule.setup('docs', app, document);

  // Redis Socket.io adapter
  const pubClient = new Redis(configService.get('REDIS_URL')!, {
    maxRetriesPerRequest: null,
  });
  const subClient = pubClient.duplicate();

  class RedisIoAdapter extends IoAdapter {
    private adapterConstructor: ReturnType<typeof createAdapter>;

    async connectToRedis(): Promise<void> {
      this.adapterConstructor = createAdapter(pubClient, subClient);
    }

    createIOServer(port: number, options?: any) {
      const server = super.createIOServer(port, options);
      server.adapter(this.adapterConstructor);
      return server;
    }
  }

  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  app.enableShutdownHooks();

  const port = parseInt(configService.get('PORT') ?? '4000', 10);
  app.listen(port, '0.0.0.0', () => {
    logger.log(`Running on port ${port}`);
  });
}
bootstrap();
