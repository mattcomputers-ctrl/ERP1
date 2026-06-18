import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
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

  @Put(':key')
  set(@Param('key') key: string, @Body('value') value: string, @CurrentUser() actor: Actor) {
    return this.settings.set(key, String(value ?? ''), actor.label ?? actor.id);
  }
}
