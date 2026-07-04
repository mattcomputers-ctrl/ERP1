import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CreatePoFromPlanDto } from './dto/create-po-from-plan.dto';
import { PlanningPoService } from './planning-po.service';
import { PlanningRecalcService } from './planning-recalc.service';
import { PlanningService, type PlanTraceListQuery } from './planning.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('planning.trace')
@Controller('planning')
export class PlanningController {
  constructor(
    private readonly planning: PlanningService,
    private readonly recalc: PlanningRecalcService,
    private readonly planningPo: PlanningPoService,
  ) {}

  // Plan Tracing set viewer (UG §14.2): the plan's requirements in sequence.
  @Get('trace')
  trace(@Query() query: PlanTraceListQuery) {
    return this.planning.trace(query);
  }

  // Short Inventory set viewer (UG §14.3): what needs to be ordered.
  @Get('short')
  @RequireProgram('planning.short')
  short(@Query('source') source?: string) {
    return this.planning.short(source);
  }

  // Recalculate Plan Trace (UG §14.1): rebuild the plan with the native
  // engine and switch the viewers to it.
  @Post('recalculate')
  @RequireProgram('planning.recalculate')
  recalculate(@CurrentUser() actor: Actor) {
    return this.recalc.recalculate(actor);
  }

  // Create Purchase Order from selected Short lines (UG §14.2.1).
  @Post('create-po')
  @RequireProgram('planning.createPo')
  createPo(@Body() dto: CreatePoFromPlanDto, @CurrentUser() actor: Actor) {
    return this.planningPo.createPoFromPlan(dto, actor);
  }
}
