import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { RejectApprovalRequestDto } from '../approval/dto/reject-request.dto';
import { CreateShippingOrderDto, ShippingLineDto } from './dto/create-shipping-order.dto';
import { UpdateShippingOrderLineDto } from './dto/edit-sh-line.dto';
import { ShippingService } from './shipping.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('shipping.create')
@Controller('shipping-orders')
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Post()
  create(@Body() dto: CreateShippingOrderDto, @CurrentUser() actor: Actor) {
    return this.shipping.create(dto, actor);
  }

  @Get('customer-options')
  customerOptions(@Query('q') q?: string) {
    return this.shipping.customerOptions(q);
  }

  @Get('carrier-options')
  carrierOptions(@Query('q') q?: string) {
    return this.shipping.carrierOptions(q);
  }

  @Get('terms-options')
  termsOptions() {
    return this.shipping.termsOptions();
  }

  @Get('item-options')
  itemOptions(@Query('q') q?: string) {
    return this.shipping.itemOptions(q);
  }

  // Sale price for a line from the customer's price list (drives the form pre-fill).
  @Get('price')
  salePrice(
    @Query('customerId', ParseIntPipe) customerId: number,
    @Query('itemId', ParseIntPipe) itemId: number,
    @Query('qty') qty?: string,
  ) {
    return this.shipping.salePrice(customerId, itemId, qty ? Number(qty) : 1);
  }

  // Pending SH line-edit approval requests + approve/reject (static paths before
  // the :id/lines param routes). Inherit the controller's shipping.create gate.
  @Get('line-approvals')
  lineApprovals() {
    return this.shipping.listShLineApprovals();
  }

  @Post('line-approvals/:requestId/approve')
  approveLineEdit(@Param('requestId', ParseIntPipe) requestId: number, @CurrentUser() actor: Actor) {
    return this.shipping.approveShLineEdit(requestId, actor);
  }

  @Post('line-approvals/:requestId/reject')
  rejectLineEdit(@Param('requestId', ParseIntPipe) requestId: number, @Body() dto: RejectApprovalRequestDto, @CurrentUser() actor: Actor) {
    return this.shipping.rejectShLineEdit(requestId, dto, actor);
  }

  // Line-level edits on a not-started SH order. Inherit the controller's
  // shipping.create gate (the same right that creates the order's lines).
  @Post(':id/lines')
  addLine(@Param('id', ParseIntPipe) id: number, @Body() dto: ShippingLineDto, @CurrentUser() actor: Actor) {
    return this.shipping.addLine(id, dto, actor);
  }

  @Patch(':id/lines/:lineId')
  updateLine(
    @Param('id', ParseIntPipe) id: number,
    @Param('lineId', ParseIntPipe) lineId: number,
    @Body() dto: UpdateShippingOrderLineDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.shipping.updateLine(id, lineId, dto, actor);
  }

  @Delete(':id/lines/:lineId')
  removeLine(@Param('id', ParseIntPipe) id: number, @Param('lineId', ParseIntPipe) lineId: number, @CurrentUser() actor: Actor) {
    return this.shipping.removeLine(id, lineId, actor);
  }
}
