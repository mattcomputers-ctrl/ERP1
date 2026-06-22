import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import helmet from 'helmet';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';

// BigInt (used by audit-log / e-signature ids) is not JSON-serializable by
// default. Patch once at module load so every app (the real server AND the
// HTTP test harness) serializes BigInt the same way.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

export interface ConfigureAppOptions {
  /**
   * The express-session store. Production passes a Redis-backed store; tests
   * pass an in-memory store. Left undefined, express-session falls back to its
   * built-in MemoryStore.
   */
  sessionStore?: session.Store;
}

/**
 * Apply the global HTTP wiring shared by the real server (`main.ts`) and the
 * HTTP-layer test harness: the `api` route prefix, security middleware, the
 * session cookie, and — critically for the test suite — the SAME global
 * `ValidationPipe` configuration. Keeping this in one place means a regression
 * in the pipe options (whitelist / forbidNonWhitelisted / transform) or the
 * session/prefix wiring is exercised by the controller tests rather than only
 * appearing in production.
 */
export function configureApp(app: NestExpressApplication, opts: ConfigureAppOptions = {}): void {
  // Behind the Caddy reverse proxy in production; harmless under supertest.
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());

  const ttlHours = Number(process.env.SESSION_TTL_HOURS ?? '12');
  const isHttps = (process.env.PUBLIC_URL ?? '').startsWith('https');

  app.use(
    session({
      store: opts.sessionStore,
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

  // Translate Prisma known-request errors (e.g. a unique-constraint race) into
  // clean HTTP statuses instead of a raw 500. Shared by the server and the tests.
  app.useGlobalFilters(new PrismaExceptionFilter());
}
