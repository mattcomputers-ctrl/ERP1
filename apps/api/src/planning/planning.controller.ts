import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PlanningService, type PlanTraceListQuery } from './planning.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('planning.trace')
@Controller('planning')
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  // Plan Tracing set viewer (UG §14.2): the plan's requirements in sequence.
  @Get('trace')
  trace(@Query() query: PlanTraceListQuery) {
    return this.planning.trace(query);
  }

  // Short Inventory set viewer (UG §14.3): what needs to be ordered.
  @Get('short')
  @RequireProgram('planning.short')
  short() {
    return this.planning.short();
  }
}
