import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { LegacyImportService } from './legacy-import.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('admin.import')
@Controller('import')
export class ImportController {
  constructor(private readonly importer: LegacyImportService) {}

  @Post('run')
  run(@CurrentUser() actor: Actor) {
    return this.importer.run(actor.label ?? actor.id);
  }

  @Get('runs')
  runs() {
    return this.importer.listRuns();
  }
}
