import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import type { ListQuery } from '../common/list';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';
import { ReverseReceiptDto } from './dto/reverse-receipt.dto';
import { TransferInventoryDto } from './dto/transfer-inventory.dto';
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

  // Container/lot label data for a parcel (legacy PrintContainerLabel —
  // 25,434 uses; reprint = reopening the page).
  @Get('inventory/:id/label')
  @RequireProgram('inventory.browser')
  containerLabel(@Param('id', ParseIntPipe) id: number) {
    return this.inventory.containerLabel(id);
  }

  // Adjust an on-hand parcel to a counted quantity (write-on / write-off).
  @Post('inventory/adjust')
  @RequireProgram('inventory.adjust')
  adjust(@Body() dto: AdjustInventoryDto, @CurrentUser() actor: Actor) {
    return this.inventory.adjust(dto, actor);
  }

  // Location picker for the transfer form (declared before the param-free posts
  // is irrelevant — distinct paths).
  @Get('inventory/location-options')
  @RequireProgram('inventory.transfer')
  locationOptions(@Query('q') q?: string) {
    return this.inventory.locationOptions(q);
  }

  // Move a quantity of an on-hand parcel to another location.
  @Post('inventory/transfer')
  @RequireProgram('inventory.transfer')
  transfer(@Body() dto: TransferInventoryDto, @CurrentUser() actor: Actor) {
    return this.inventory.transfer(dto, actor);
  }

  // Reverse a posted purchase/misc receipt (only while its stock is untouched).
  @Post('inventory/receipts/:changeSetId/reverse')
  @RequireProgram('inventory.reverse')
  reverseReceipt(@Param('changeSetId', ParseIntPipe) changeSetId: number, @Body() dto: ReverseReceiptDto, @CurrentUser() actor: Actor) {
    return this.inventory.reverseReceipt(changeSetId, dto, actor);
  }
}
