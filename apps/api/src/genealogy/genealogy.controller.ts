import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { GenealogyService } from './genealogy.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@Controller()
export class GenealogyController {
  constructor(private readonly genealogy: GenealogyService) {}

  @Get('recall')
  @RequireProgram('inventory.recall')
  recall(@Query('lot') lot?: string, @Query('sublot') sublot?: string, @Query('q') q?: string) {
    return this.genealogy.recall({ lot, sublot: sublot ? Number(sublot) : undefined, q });
  }

  @Get('trace')
  @RequireProgram('inventory.trace')
  trace(@Query('lot') lot?: string, @Query('sublot') sublot?: string, @Query('q') q?: string) {
    return this.genealogy.trace({ lot, sublot: sublot ? Number(sublot) : undefined, q });
  }

  // Recompute the derived lot genealogy on demand (also runs after each import).
  @Post('genealogy/derive')
  @RequireProgram('admin.import')
  derive() {
    return this.genealogy.derive();
  }
}
