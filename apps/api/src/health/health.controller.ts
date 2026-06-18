import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  // lazyConnect: ioredis connects on the first command (ping) and manages
  // reconnection itself, so we never call connect() manually.
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    let db = 'down';
    let redis = 'down';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      /* db down */
    }

    try {
      await this.redis.ping();
      redis = 'up';
    } catch {
      /* redis down */
    }

    const ok = db === 'up' && redis === 'up';
    // Non-2xx when degraded so orchestrator healthchecks and the installer's
    // `curl -f` reflect real health.
    res.status(ok ? 200 : 503);

    return {
      status: ok ? 'ok' : 'degraded',
      db,
      redis,
      version: process.env.APP_VERSION ?? '0.1.0',
      time: new Date().toISOString(),
    };
  }
}
