import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Application configuration (key/value), runtime-editable. */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.appSetting.findMany({ orderBy: { key: 'asc' } });
  }

  async get(key: string, fallback: string): Promise<string> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    return row?.value ?? fallback;
  }

  async getNumber(key: string, fallback: number): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) ? n : fallback;
  }

  set(key: string, value: string, updatedBy?: string) {
    return this.prisma.appSetting.upsert({
      where: { key },
      update: { value, updatedBy: updatedBy ?? null },
      create: { key, value, updatedBy: updatedBy ?? null },
    });
  }
}
