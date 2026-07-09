import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { StageParcelsDto } from './dto/stage-parcels.dto';
import { UnstageParcelsDto } from './dto/unstage-parcels.dto';
import { StagingService } from './staging.service';

/**
 * Pre-shipment staging (the legacy "Shipping Assembly" program): reserve
 * on-hand parcels to an open SH order's lines inside a native ASM assembly
 * location. Its own program — staging is a warehouse operation, not order
 * entry (shipping.create) or closing (orders.ship).
 */
@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('shipping.stage')
@Controller()
export class StagingController {
  constructor(private readonly staging: StagingService) {}

  @Get('shipping-orders/:id/staging')
  staging_(@Param('id', ParseIntPipe) id: number) {
    return this.staging.staging(id);
  }

  @Get('shipping-orders/:id/stage-candidates')
  candidates(@Param('id', ParseIntPipe) id: number, @Query('ordDetailId', ParseIntPipe) ordDetailId: number) {
    return this.staging.stageCandidates(id, ordDetailId);
  }

  @Post('shipping-orders/:id/assemblies')
  createAssembly(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.staging.createAssembly(id, actor);
  }

  @Post('shipping-orders/:id/assemblies/:locationId/stage')
  stage(
    @Param('id', ParseIntPipe) id: number,
    @Param('locationId', ParseIntPipe) locationId: number,
    @Body() dto: StageParcelsDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.staging.stage(id, locationId, dto, actor);
  }

  @Post('shipping-orders/:id/unstage')
  unstage(@Param('id', ParseIntPipe) id: number, @Body() dto: UnstageParcelsDto, @CurrentUser() actor: Actor) {
    return this.staging.unstage(id, dto, actor);
  }

  /** Printable assembly-label data (order, ship-to, contents). */
  @Get('assemblies/:locationId/label')
  label(@Param('locationId', ParseIntPipe) locationId: number) {
    return this.staging.assemblyLabel(locationId);
  }
}
