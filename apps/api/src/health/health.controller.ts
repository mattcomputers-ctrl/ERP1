import { Controller, Get } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    let db = 'down';
    let redis = 'down';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      /* db down */
    }

    try {
      if (this.redis.status !== 'ready') await this.redis.connect();
      await this.redis.ping();
      redis = 'up';
    } catch {
      /* redis down */
    }

    return {
      status: db === 'up' && redis === 'up' ? 'ok' : 'degraded',
      db,
      redis,
      version: process.env.APP_VERSION ?? '0.1.0',
      time: new Date().toISOString(),
    };
  }
}
