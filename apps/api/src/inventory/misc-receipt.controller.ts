import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { ListQuery } from '../common/list';
import { CreateMiscReceiptDto } from './dto/misc-receipt.dto';
import { MiscReceiptService } from './misc-receipt.service';

// Miscellaneous (non-PO) inventory receipts — create stock without a purchase
// order. Gated by inventory.receipts.
@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('inventory.receipts')
@Controller('inventory-receipts')
export class MiscReceiptController {
  constructor(private readonly receipts: MiscReceiptService) {}

  @Get()
  list(@Query() query: ListQuery) {
    return this.receipts.list(query);
  }

  // Declared before any param route (none here, but keeps the pattern).
  @Get('item-options')
  itemOptions(@Query('q') q?: string) {
    return this.receipts.itemOptions(q);
  }

  @Post()
  create(@Body() dto: CreateMiscReceiptDto, @CurrentUser() actor: Actor) {
    return this.receipts.receive(dto, actor);
  }
}
