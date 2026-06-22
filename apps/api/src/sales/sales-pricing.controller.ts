import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { ListQuery } from '../common/list';
import {
  AssignCustomerDto,
  CreatePriceDetailDto,
  CreatePriceListDto,
  CreatePriceVersionDto,
  UpdatePriceDetailDto,
} from './dto/price-list.dto';
import { SalesPricingService } from './sales-pricing.service';

// Sales price-list editor. Browsing is gated by `sales.priceLists`; every write
// requires the stricter `sales.priceListEditor` (method-level override).
@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('sales.priceLists')
@Controller('price-lists')
export class SalesPricingController {
  constructor(private readonly pricing: SalesPricingService) {}

  @Get()
  list(@Query() query: ListQuery) {
    return this.pricing.list(query);
  }

  @Post()
  @RequireProgram('sales.priceListEditor')
  create(@Body() dto: CreatePriceListDto, @CurrentUser() actor: Actor) {
    return this.pricing.createPriceList(dto, actor);
  }

  // Pickers for the editor form — gated by the editor program. Declared before
  // :id so they aren't swallowed by the param route.
  @Get('item-options')
  @RequireProgram('sales.priceListEditor')
  itemOptions(@Query('q') q?: string) {
    return this.pricing.itemOptions(q);
  }

  @Get('customer-options')
  @RequireProgram('sales.priceListEditor')
  customerOptions(@Query('q') q?: string) {
    return this.pricing.customerOptions(q);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.pricing.get(id);
  }

  @Post(':id/versions')
  @RequireProgram('sales.priceListEditor')
  createVersion(@Param('id', ParseIntPipe) id: number, @Body() dto: CreatePriceVersionDto, @CurrentUser() actor: Actor) {
    return this.pricing.createPriceVersion(id, dto, actor);
  }

  @Post(':id/versions/:versionId/details')
  @RequireProgram('sales.priceListEditor')
  addDetail(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Body() dto: CreatePriceDetailDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.pricing.addPriceDetail(id, versionId, dto, actor);
  }

  @Patch(':id/details/:detailId')
  @RequireProgram('sales.priceListEditor')
  updateDetail(
    @Param('id', ParseIntPipe) id: number,
    @Param('detailId', ParseIntPipe) detailId: number,
    @Body() dto: UpdatePriceDetailDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.pricing.updatePriceDetail(id, detailId, dto, actor);
  }

  @Delete(':id/details/:detailId')
  @RequireProgram('sales.priceListEditor')
  deleteDetail(
    @Param('id', ParseIntPipe) id: number,
    @Param('detailId', ParseIntPipe) detailId: number,
    @CurrentUser() actor: Actor,
  ) {
    return this.pricing.deletePriceDetail(id, detailId, actor);
  }

  @Post(':id/customers')
  @RequireProgram('sales.priceListEditor')
  assignCustomer(@Param('id', ParseIntPipe) id: number, @Body() dto: AssignCustomerDto, @CurrentUser() actor: Actor) {
    return this.pricing.assignCustomer(id, dto, actor);
  }

  @Delete(':id/customers/:customerId')
  @RequireProgram('sales.priceListEditor')
  unassignCustomer(
    @Param('id', ParseIntPipe) id: number,
    @Param('customerId', ParseIntPipe) customerId: number,
    @CurrentUser() actor: Actor,
  ) {
    return this.pricing.unassignCustomer(id, customerId, actor);
  }
}
