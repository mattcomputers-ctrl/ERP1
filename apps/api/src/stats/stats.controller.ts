import { Controller, Get, UseGuards } from '@nestjs/common';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { StatsService } from './stats.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('dashboard')
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  overview() {
    return this.stats.overview();
  }
}
