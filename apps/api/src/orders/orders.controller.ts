import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AddExecutionLineDto } from './dto/add-execution-line.dto';
import { CloseOrderDto } from './dto/close-order.dto';
import { CompleteOrderDto } from './dto/complete-order.dto';
import { ConsumeLotsDto } from './dto/consume-lots.dto';
import { ConsumeQtyDto } from './dto/consume-qty.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { EditOrderDto } from './dto/edit-order.dto';
import { IptResultsDto } from './dto/ipt-results.dto';
import { RecordLineDto } from './dto/record-line.dto';
import { RejectEditApprovalDto } from './dto/edit-approval.dto';
import { ShipLotsDto } from './dto/ship-lots.dto';
import { OrdersService, type OrdersListQuery } from './orders.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('orders.browser')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query() query: OrdersListQuery) {
    return this.orders.list(query);
  }

  // Create a batch order natively from a recipe (front of the §4.3 lifecycle).
  @Post()
  @RequireProgram('orders.create')
  create(@Body() dto: CreateOrderDto, @CurrentUser() actor: Actor) {
    return this.orders.create(dto, actor);
  }

  // Recipe picker for the create form — gated by orders.create (not
  // recipe.manager). Declared before :id so it isn't swallowed by the param route.
  @Get('recipe-options')
  @RequireProgram('orders.create')
  recipeOptions(@Query('q') q?: string) {
    return this.orders.recipeOptions(q);
  }

  // Item picker for the FIFO consume-by-quantity form (gated by orders.consume).
  @Get('consume-item-options')
  @RequireProgram('orders.consume')
  consumeItemOptions(@Query('q') q?: string) {
    return this.orders.consumeItemOptions(q);
  }

  // The same picker for the batch-addition form — gated by orders.execute so an
  // execution operator doesn't also need the order-level consume program.
  @Get('execution-item-options')
  @RequireProgram('orders.execute')
  executionItemOptions(@Query('q') q?: string) {
    return this.orders.consumeItemOptions(q);
  }

  // E-signature requirements for completing an order (drives the complete form).
  @Get('complete-requirement')
  @RequireProgram('orders.complete')
  completeRequirement(@CurrentUser() actor: Actor) {
    return this.orders.completeRequirement(actor.id);
  }

  // Pending order-edit approval requests (static path before :id).
  @Get('edit-approvals')
  @RequireProgram('orders.edit')
  editApprovals() {
    return this.orders.listEditApprovals();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.orders.get(id);
  }

  @Get(':id/batch-sheet')
  batchSheet(@Param('id', ParseIntPipe) id: number) {
    return this.orders.batchSheet(id);
  }

  // Edit a not-yet-released order (rescale to a new batch size / header fields).
  // A group that can approve updates enacts directly; a request-only group
  // submits a blocking approval request (see the edit-approvals routes).
  @Post(':id/edit')
  @RequireProgram('orders.edit')
  edit(@Param('id', ParseIntPipe) id: number, @Body() dto: EditOrderDto, @CurrentUser() actor: Actor) {
    return this.orders.edit(id, dto, actor);
  }

  // Approve / reject a pending order-edit request.
  @Post('edit-approvals/:requestId/approve')
  @RequireProgram('orders.edit')
  approveEdit(@Param('requestId', ParseIntPipe) requestId: number, @CurrentUser() actor: Actor) {
    return this.orders.approveEdit(requestId, actor);
  }

  @Post('edit-approvals/:requestId/reject')
  @RequireProgram('orders.edit')
  rejectEdit(@Param('requestId', ParseIntPipe) requestId: number, @Body() dto: RejectEditApprovalDto, @CurrentUser() actor: Actor) {
    return this.orders.rejectEdit(requestId, dto, actor);
  }

  // --- lifecycle transitions (each gated by its own program) ---------------

  @Post(':id/release')
  @RequireProgram('orders.release')
  release(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.orders.release(id, actor);
  }

  @Post(':id/complete')
  @RequireProgram('orders.complete')
  complete(@Param('id', ParseIntPipe) id: number, @Body() dto: CompleteOrderDto, @CurrentUser() actor: Actor) {
    return this.orders.complete(id, dto, actor);
  }

  @Post(':id/close')
  @RequireProgram('orders.close')
  close(@Param('id', ParseIntPipe) id: number, @Body() dto: CloseOrderDto, @CurrentUser() actor: Actor) {
    return this.orders.close(id, dto, actor);
  }

  // --- guided batch execution (dispense/weigh per line, batch additions, IPT) ---

  // The execution panel: procedure lines with planned vs actual + per-line
  // status, dispense lot options for traced items, and IPT tests + results.
  @Get(':id/execution')
  @RequireProgram('orders.execute')
  execution(@Param('id', ParseIntPipe) id: number) {
    return this.orders.execution(id);
  }

  // Record one line's execution: actual dispensed qty (+ lots when traced) on a
  // material line, or a plain check-off on an instruction line.
  @Post(':id/lines/:lineId/record')
  @RequireProgram('orders.execute')
  recordLine(
    @Param('id', ParseIntPipe) id: number,
    @Param('lineId', ParseIntPipe) lineId: number,
    @Body() dto: RecordLineDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.orders.recordLine(id, lineId, dto, actor);
  }

  // A batch addition: an ingredient added during execution beyond the recipe.
  @Post(':id/execution/lines')
  @RequireProgram('orders.execute')
  addExecutionLine(@Param('id', ParseIntPipe) id: number, @Body() dto: AddExecutionLineDto, @CurrentUser() actor: Actor) {
    return this.orders.addExecutionLine(id, dto, actor);
  }

  // Record in-process test results during execution (ERP1 extension — legacy
  // results were handwritten on the paper ticket).
  @Post(':id/ipt-results')
  @RequireProgram('orders.execute')
  recordIptResults(@Param('id', ParseIntPipe) id: number, @Body() dto: IptResultsDto, @CurrentUser() actor: Actor) {
    return this.orders.recordIptResults(id, dto, actor);
  }

  // Material-variance report: planned vs actual per material line + yield.
  // Own program (not the controller's orders.browser default): the report
  // carries unit costs / purchase prices a browse-only user shouldn't see.
  @Get(':id/variance')
  @RequireProgram('orders.variance')
  variance(@Param('id', ParseIntPipe) id: number) {
    return this.orders.variance(id);
  }

  // Record the raw-material lots a batch consumed (lineage for recall).
  @Post(':id/consume-lots')
  @RequireProgram('orders.consume')
  consumeLots(@Param('id', ParseIntPipe) id: number, @Body() dto: ConsumeLotsDto, @CurrentUser() actor: Actor) {
    return this.orders.consumeLots(id, dto, actor);
  }

  // Consume not-lot-traced items by quantity, FIFO (oldest units first).
  @Post(':id/consume-qty')
  @RequireProgram('orders.consume')
  consumeQuantity(@Param('id', ParseIntPipe) id: number, @Body() dto: ConsumeQtyDto, @CurrentUser() actor: Actor) {
    return this.orders.consumeQuantity(id, dto, actor);
  }

  // Lot-picker options for closing a shipping order (on-hand FG lots per traced line).
  @Get(':id/ship-lot-options')
  @RequireProgram('orders.ship')
  shipLotOptions(@Param('id', ParseIntPipe) id: number) {
    return this.orders.shipLotOptions(id);
  }

  // Record the finished-good lots a shipping order shipped (lot -> shipment for recall).
  @Post(':id/ship-lots')
  @RequireProgram('orders.ship')
  shipLots(@Param('id', ParseIntPipe) id: number, @Body() dto: ShipLotsDto, @CurrentUser() actor: Actor) {
    return this.orders.shipLots(id, dto, actor);
  }
}
