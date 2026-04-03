import 'dotenv/config';

// Now safe to import modules that depend on environment variables
import helmet from 'helmet';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';

async function bootstrap() {
  // create app
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // logger for debug purposes
  const logger = new Logger('API_GATEWAY');

  /// MIDDLEWARES
  // 1. cors
  app.enableCors({
    origin: ['http://localhost:3000'],
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  });
  // 2. helmet
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          imgSrc: [
            `'self'`,
            'data:',
            'apollo-server-landing-page.cdn.apollographql.com',
          ],
          scriptSrc: [`'self'`, `https: 'unsafe-inline'`],
          manifestSrc: [
            `'self'`,
            'apollo-server-landing-page.cdn.apollographql.com',
          ],
          frameSrc: [`'self'`, 'sandbox.embed.apollographql.com'],
        },
      },
    }),
  );

  /// ROUTE PREFIX
  app.setGlobalPrefix('api', {
    exclude: ['/health', '/docs'],
  });

  /// DOCUMENTATIONS
  const swaggerDoc = new DocumentBuilder()
    .setTitle('Fintrack Api Docs')
    .setDescription(
      'API documentation for Fintrack, A financial tracking tool (Nest/TypeScript) backend application.\n',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerDoc);
  SwaggerModule.setup('docs', app, document);

  // set up redis
  const pubClient = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,
  });
  const subClient = pubClient.duplicate();

  // 2. Create the custom Socket.io Adapter
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

  // 3. Connect and apply the adapter
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();

  app.useWebSocketAdapter(redisIoAdapter);

  app.enableShutdownHooks();

  // start server
  const port = Number(process.env.API_GATEWAY_PORT);
  app.listen(port, () => {
    logger.log(`Running on port ${port}`);
  });
}
bootstrap();
