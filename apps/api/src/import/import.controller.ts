import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { LegacyImportService } from './legacy-import.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('admin.import')
@Controller('import')
export class ImportController {
  constructor(private readonly importer: LegacyImportService) {}

  // Optional ?only=Table1,Table2 imports just those tables (faster re-import).
  @Post('run')
  run(@CurrentUser() actor: Actor, @Query('only') only?: string) {
    const tables = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return this.importer.run(actor.label ?? actor.id, tables);
  }

  @Get('runs')
  runs() {
    return this.importer.listRuns();
  }
}
