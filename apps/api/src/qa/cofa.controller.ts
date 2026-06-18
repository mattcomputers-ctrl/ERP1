import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { ListQuery } from '../common/list';
import { CofaService } from './cofa.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('qa.cofa')
@Controller('cofa')
export class CofaController {
  constructor(private readonly cofa: CofaService) {}

  @Get()
  list(@Query() query: ListQuery) {
    return this.cofa.list(query);
  }

  @Get(':releaseId')
  get(@Param('releaseId', ParseIntPipe) releaseId: number) {
    return this.cofa.get(releaseId);
  }
}
