import { BadRequestException, Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { SETTINGS_BY_KEY, SETTINGS_REGISTRY, SETTING_GROUPS } from './settings-registry';
import { SettingsService } from './settings.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('admin.config')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  list() {
    return this.settings.list();
  }

  /**
   * The Configuration page's model (§14 / UG ch.19): every registered setting
   * with its current value (stored value, else the registry default), grouped
   * to mirror the legacy Configuration Update tabs.
   */
  @Get('registry')
  async registry() {
    const stored = new Map((await this.settings.list()).map((s) => [s.key, s]));
    return {
      groups: SETTING_GROUPS,
      settings: SETTINGS_REGISTRY.map((def) => ({
        ...def,
        value: stored.get(def.key)?.value ?? def.defaultValue,
        updatedBy: stored.get(def.key)?.updatedBy ?? null,
        updatedAt: stored.get(def.key)?.updatedAt ?? null,
      })),
    };
  }

  @Put(':key')
  async set(@Param('key') key: string, @Body('value') value: string, @CurrentUser() actor: Actor) {
    const v = String(value ?? '');
    // Registered keys get type validation + the read-only guard; unregistered
    // keys stay writable (forward compatibility for keys code reads before the
    // registry catches up).
    const def = SETTINGS_BY_KEY.get(key);
    if (def) {
      if (def.readonly) throw new BadRequestException(`'${key}' is system-maintained and cannot be edited.`);
      // Blank must NOT pass as a number: Number('') === 0, and a cleared
      // field silently zeroing a knob is exactly how the brute-force lockout
      // would get disabled by accident (review finding). Every registered
      // number key is a non-negative count/percent/port/threshold, so
      // negatives are rejected too — "reset to default" is done by typing
      // the default, never by blanking.
      if (def.type === 'number' && (v.trim() === '' || !Number.isFinite(Number(v)) || Number(v) < 0)) {
        throw new BadRequestException(`'${key}' must be a non-negative number.`);
      }
      if (def.type === 'boolean' && v !== 'true' && v !== 'false') {
        throw new BadRequestException(`'${key}' must be 'true' or 'false'.`);
      }
      if (def.type === 'select' && def.options && !def.options.includes(v)) {
        throw new BadRequestException(`'${key}' must be one of: ${def.options.join(', ')}.`);
      }
    }
    return this.settings.set(key, v, actor.label ?? actor.id);
  }
}
