import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import RedisStore from 'connect-redis';
import { Redis } from 'ioredis';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    maxRetriesPerRequest: null,
  });
  const sessionStore = new RedisStore({ client: redis, prefix: 'erp1:sess:' });

  // Global HTTP wiring (prefix / helmet / session / ValidationPipe) — shared
  // verbatim with the HTTP-layer test harness. See src/bootstrap.ts.
  configureApp(app, { sessionStore });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ERP1 API')
    .setDescription('Internal manufacturing/ERP system API')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(process.env.API_PORT ?? '3000');
  await app.listen(port, '0.0.0.0');
  new Logger('bootstrap').log(`ERP1 API listening on :${port} (docs at /api/docs)`);
}

void bootstrap();
