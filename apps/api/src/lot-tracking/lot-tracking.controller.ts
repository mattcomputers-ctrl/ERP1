import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { ListQuery } from '../common/list';
import { EnableLotTrackingDto } from './dto/enable-lot-tracking.dto';
import { LotTrackingService } from './lot-tracking.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('inventory.lotTracking')
@Controller('lot-tracking')
export class LotTrackingController {
  constructor(private readonly lotTracking: LotTrackingService) {}

  @Get('items')
  items(@Query() query: ListQuery & { tracked?: string }) {
    return this.lotTracking.items(query);
  }

  @Get('locations')
  locations(@Query('q') q?: string) {
    return this.lotTracking.locationOptions(q);
  }

  @Post('items/:id/enable')
  enable(@Param('id', ParseIntPipe) id: number, @Body() dto: EnableLotTrackingDto, @CurrentUser() actor: Actor) {
    return this.lotTracking.enable(id, dto, actor);
  }

  @Post('items/:id/disable')
  disable(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.lotTracking.disable(id, actor);
  }
}
