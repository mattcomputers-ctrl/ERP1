import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import type { ListQuery } from '../common/list';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PackingSlipService } from './packing-slip.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('sales.shipments')
@Controller('packing-slips')
export class PackingSlipController {
  constructor(private readonly packingSlips: PackingSlipService) {}

  @Get()
  list(@Query() query: ListQuery) {
    return this.packingSlips.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.packingSlips.get(id);
  }
}
