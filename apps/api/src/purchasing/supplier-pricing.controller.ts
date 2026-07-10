import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { ListQuery } from '../common/list';
import {
  CreateSupplierPriceDetailDto,
  CreateSupplierPriceVersionDto,
  UpdateSupplierPriceDetailDto,
} from './dto/price-version.dto';
import { SupplierPricingService } from './supplier-pricing.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('purchasing.priceVersions')
@Controller('supplier-pricing')
export class SupplierPricingController {
  constructor(private readonly pricing: SupplierPricingService) {}

  @Get()
  list(@Query() query: ListQuery & { q?: string }) {
    return this.pricing.list(query);
  }

  // Pickers — declared before :supplierId so they aren't swallowed by the param route.
  @Get('item-options')
  itemOptions(@Query('q') q?: string) {
    return this.pricing.itemOptions(q);
  }

  @Get('supplier-options')
  supplierOptions(@Query('q') q?: string) {
    return this.pricing.supplierOptions(q);
  }

  @Get('manufacturer-options')
  manufacturerOptions(@Query('q') q?: string) {
    return this.pricing.manufacturerOptions(q);
  }

  @Get(':supplierId')
  get(@Param('supplierId', ParseIntPipe) supplierId: number) {
    return this.pricing.get(supplierId);
  }

  @Post(':supplierId/versions')
  @RequireProgram('purchasing.priceVersionEditor')
  createVersion(@Param('supplierId', ParseIntPipe) supplierId: number, @Body() dto: CreateSupplierPriceVersionDto, @CurrentUser() actor: Actor) {
    return this.pricing.createVersion(supplierId, dto, actor);
  }

  @Post(':supplierId/versions/:versionId/details')
  @RequireProgram('purchasing.priceVersionEditor')
  addDetail(
    @Param('supplierId', ParseIntPipe) supplierId: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Body() dto: CreateSupplierPriceDetailDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.pricing.addDetail(supplierId, versionId, dto, actor);
  }

  @Patch(':supplierId/details/:detailId')
  @RequireProgram('purchasing.priceVersionEditor')
  updateDetail(
    @Param('supplierId', ParseIntPipe) supplierId: number,
    @Param('detailId', ParseIntPipe) detailId: number,
    @Body() dto: UpdateSupplierPriceDetailDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.pricing.updateDetail(supplierId, detailId, dto, actor);
  }

  @Delete(':supplierId/details/:detailId')
  @RequireProgram('purchasing.priceVersionEditor')
  deleteDetail(
    @Param('supplierId', ParseIntPipe) supplierId: number,
    @Param('detailId', ParseIntPipe) detailId: number,
    @CurrentUser() actor: Actor,
  ) {
    return this.pricing.deleteDetail(supplierId, detailId, actor);
  }
}
