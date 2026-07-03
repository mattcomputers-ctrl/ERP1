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

  // Incremental sync: walk the legacy change feed since the watermark and
  // re-pull only the touched keys (requires a prior full import).
  @Post('sync')
  sync(@CurrentUser() actor: Actor) {
    return this.importer.sync(actor.label ?? actor.id);
  }

  // Reconciliation report: per-table legacy vs mirror row counts (+ native
  // breakout) and the current watermark lag.
  @Get('reconcile')
  reconcile() {
    return this.importer.reconcile();
  }

  @Get('runs')
  runs() {
    return this.importer.listRuns();
  }
}
