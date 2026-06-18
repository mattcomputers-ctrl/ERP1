import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import RedisStore from 'connect-redis';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import helmet from 'helmet';
import { Redis } from 'ioredis';
import { AppModule } from './app.module';

// BigInt (used by audit-log ids) is not JSON-serializable by default.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  // Behind the Caddy reverse proxy.
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    maxRetriesPerRequest: null,
  });
  const sessionStore = new RedisStore({ client: redis, prefix: 'erp1:sess:' });

  const ttlHours = Number(process.env.SESSION_TTL_HOURS ?? '12');
  const isHttps = (process.env.PUBLIC_URL ?? '').startsWith('https');

  app.use(
    session({
      store: sessionStore,
      name: 'erp1.sid',
      secret: process.env.SESSION_SECRET ?? 'dev-insecure-secret-change-me',
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isHttps,
        maxAge: ttlHours * 60 * 60 * 1000,
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

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
