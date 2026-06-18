import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { ListQuery } from '../common/list';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { InventoryService } from './inventory.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('inventory')
  @RequireProgram('inventory.browser')
  list(@Query() query: ListQuery & { status?: string; item?: string; onHand?: string }) {
    return this.inventory.list(query);
  }
}
