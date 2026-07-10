import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import type { ListQuery } from '../common/list';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { GenerateInvoiceDto } from './dto/generate-invoice.dto';
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

  /** Generate a CI invoice (TI for warehouse ship-tos) for a shipping order's uninvoiced shipped qty. */
  @Post()
  @RequireProgram('sales.invoice')
  generate(@Body() dto: GenerateInvoiceDto, @CurrentUser() actor: Actor) {
    return this.invoices.generate(dto, actor);
  }

  /** Reverse (credit) an invoice — same document number, negated lines, ReversedTrans link. */
  @Post(':id/reverse')
  @RequireProgram('sales.invoice')
  reverse(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.invoices.reverse(id, actor);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.invoices.get(id);
  }
}
