import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { ListQuery } from '../common/list';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { PurchasingService } from './purchasing.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('purchasing.po')
@Controller('purchase-orders')
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Get()
  list(@Query() query: ListQuery) {
    return this.purchasing.list(query);
  }

  // Create a purchase order natively. Gated by purchasing.create.
  @Post()
  @RequireProgram('purchasing.create')
  create(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() actor: Actor) {
    return this.purchasing.create(dto, actor);
  }

  // Pickers for the create form — gated by purchasing.create (not the master
  // programs). Declared before :id so they aren't swallowed by the param route.
  @Get('supplier-options')
  @RequireProgram('purchasing.create')
  supplierOptions(@Query('q') q?: string) {
    return this.purchasing.supplierOptions(q);
  }

  @Get('item-options')
  @RequireProgram('purchasing.create')
  itemOptions(@Query('q') q?: string) {
    return this.purchasing.itemOptions(q);
  }

  @Get('terms-options')
  @RequireProgram('purchasing.create')
  termsOptions() {
    return this.purchasing.termsOptions();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.purchasing.get(id);
  }
}
