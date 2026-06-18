import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import type { ListQuery } from '../common/list';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { InvoicesService } from './invoices.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('sales.invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(@Query() query: ListQuery) {
    return this.invoices.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.invoices.get(id);
  }
}
