import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { DispositionDto } from './dto/disposition.dto';
import { EnterResultsDto } from './dto/enter-results.dto';
import { ReleasesService } from './releases.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('qa.disposition')
@Controller('releases')
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  // What the disposition form must collect (reason / signature / witness).
  @Get('disposition-requirement')
  requirement(@CurrentUser() actor: Actor) {
    return this.releases.dispositionRequirement(actor.id);
  }

  @Post(':id/disposition')
  disposition(@Param('id', ParseIntPipe) id: number, @Body() dto: DispositionDto, @CurrentUser() actor: Actor) {
    return this.releases.disposition(id, dto, actor);
  }

  // --- LIMS test results (gated by qa.results; recorded, not e-signed) ---

  @Get(':id/tests')
  @RequireProgram('qa.results')
  tests(@Param('id', ParseIntPipe) id: number) {
    return this.releases.tests(id);
  }

  @Post(':id/tests')
  @RequireProgram('qa.results')
  enterResults(@Param('id', ParseIntPipe) id: number, @Body() dto: EnterResultsDto, @CurrentUser() actor: Actor) {
    return this.releases.enterResults(id, dto, actor);
  }
}
