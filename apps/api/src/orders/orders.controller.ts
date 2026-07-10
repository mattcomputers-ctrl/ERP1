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
import { ExpressExecuteDto } from './dto/express-execute.dto';
import { IptResultsDto } from './dto/ipt-results.dto';
import { RecordLineDto } from './dto/record-line.dto';
import { RejectEditApprovalDto } from './dto/edit-approval.dto';
import { ReverseOrderDto } from './dto/reverse-order.dto';
import { ReverseShipmentDto } from './dto/reverse-shipment.dto';
import {
  AddRevisionLineDto,
  PublishRevisionDto,
  RejectRevisionDto,
  UpdateRevisionDto,
  UpdateRevisionLineDto,
} from './dto/revision.dto';
import { ShipLotsDto } from './dto/ship-lots.dto';
import { SpecifyPackoutDto } from './dto/specify-packout.dto';
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

  // Packout options (ItemPackagedProduct bindings): the packaging-order
  // product lookup (?q=) and a bulk item's packaging options (?itemId=).
  // Gated by orders.create like the recipe picker — it drives order creation.
  @Get('packout-options')
  @RequireProgram('orders.create')
  packoutOptions(@Query('itemId') itemId?: string, @Query('q') q?: string) {
    const parsed = itemId != null && itemId !== '' ? Number(itemId) : undefined;
    return this.orders.packoutOptions({
      itemId: parsed != null && Number.isInteger(parsed) ? parsed : undefined,
      q,
    });
  }

  // E-signature requirements for completing an order (drives the complete form).
  @Get('complete-requirement')
  @RequireProgram('orders.complete')
  completeRequirement(@CurrentUser() actor: Actor) {
    return this.orders.completeRequirement(actor.id);
  }

  // E-signature requirements for reversing a completion (drives the reverse form).
  @Get('reverse-requirement')
  @RequireProgram('orders.reverse')
  reverseRequirement(@CurrentUser() actor: Actor) {
    return this.orders.reverseRequirement(actor.id);
  }

  // Pending order-edit approval requests (static path before :id).
  @Get('edit-approvals')
  @RequireProgram('orders.edit')
  editApprovals() {
    return this.orders.listEditApprovals();
  }

  // E-signature requirements for publishing a revision (static path before :id).
  @Get('revise-requirement')
  @RequireProgram('orders.revise')
  reviseRequirement(@CurrentUser() actor: Actor) {
    return this.orders.reviseRequirement(actor.id);
  }

  // Item picker for the revision add-ingredient form (same options as batch additions).
  @Get('revise-item-options')
  @RequireProgram('orders.revise')
  reviseItemOptions(@Query('q') q?: string) {
    return this.orders.consumeItemOptions(q);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.orders.get(id);
  }

  @Get(':id/batch-sheet')
  batchSheet(@Param('id', ParseIntPipe) id: number) {
    return this.orders.batchSheet(id);
  }

  // The packout/demand picture of a production order (UG §6.4): demand table +
  // yield totals + packout options (MFBA), or the bulk-supply links (MFPP).
  @Get(':id/packouts')
  packouts(@Param('id', ParseIntPipe) id: number) {
    return this.orders.packouts(id);
  }

  // Specify a packout (UG §6.4 New Requirements): create a packaging order for
  // the chosen packout and allocate this batch's bulk to it, atomically.
  @Post(':id/packouts')
  @RequireProgram('orders.create')
  specifyPackout(@Param('id', ParseIntPipe) id: number, @Body() dto: SpecifyPackoutDto, @CurrentUser() actor: Actor) {
    return this.orders.specifyPackout(id, dto, actor);
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

  // --- §7 order-edit revisions (edit a RELEASED order via a published draft) ---

  // The revision picture: published history, open draft with lines, canRevise.
  // Gated by the controller's orders.browser default — it is part of viewing.
  @Get(':id/revisions')
  revisions(@Param('id', ParseIntPipe) id: number) {
    return this.orders.revisions(id);
  }

  // One revision's line set (a published snapshot or the open draft).
  @Get(':id/revisions/:editId')
  revisionLines(@Param('id', ParseIntPipe) id: number, @Param('editId', ParseIntPipe) editId: number) {
    return this.orders.revisionLines(id, editId);
  }

  // Open a revision draft on a Released production order (order goes EDT).
  @Post(':id/revisions')
  @RequireProgram('orders.revise')
  createRevision(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.orders.createRevision(id, actor);
  }

  // Draft header (the revision comment — required before publish).
  @Post(':id/revisions/draft')
  @RequireProgram('orders.revise')
  updateRevision(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRevisionDto, @CurrentUser() actor: Actor) {
    return this.orders.updateRevision(id, dto, actor);
  }

  // Add an ingredient / instruction / IPT line to the draft.
  @Post(':id/revisions/draft/lines')
  @RequireProgram('orders.revise')
  addRevisionLine(@Param('id', ParseIntPipe) id: number, @Body() dto: AddRevisionLineDto, @CurrentUser() actor: Actor) {
    return this.orders.addRevisionLine(id, dto, actor);
  }

  // Change a draft line (quantity on material lines, comment on any editable one).
  @Post(':id/revisions/draft/lines/:lineId')
  @RequireProgram('orders.revise')
  updateRevisionLine(
    @Param('id', ParseIntPipe) id: number,
    @Param('lineId', ParseIntPipe) lineId: number,
    @Body() dto: UpdateRevisionLineDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.orders.updateRevisionLine(id, lineId, dto, actor);
  }

  // Remove a line from the draft (cancels an addition / marks a live line for removal).
  @Post(':id/revisions/draft/lines/:lineId/remove')
  @RequireProgram('orders.revise')
  deleteRevisionLine(
    @Param('id', ParseIntPipe) id: number,
    @Param('lineId', ParseIntPipe) lineId: number,
    @CurrentUser() actor: Actor,
  ) {
    return this.orders.deleteRevisionLine(id, lineId, actor);
  }

  // Undo a mark-for-removal on a copied draft line.
  @Post(':id/revisions/draft/lines/:lineId/restore')
  @RequireProgram('orders.revise')
  restoreRevisionLine(
    @Param('id', ParseIntPipe) id: number,
    @Param('lineId', ParseIntPipe) lineId: number,
    @CurrentUser() actor: Actor,
  ) {
    return this.orders.restoreRevisionLine(id, lineId, actor);
  }

  // Publish the draft — apply it to the order (e-signable; UG §7.1.8).
  @Post(':id/revisions/draft/publish')
  @RequireProgram('orders.revise')
  publishRevision(@Param('id', ParseIntPipe) id: number, @Body() dto: PublishRevisionDto, @CurrentUser() actor: Actor) {
    return this.orders.publishRevision(id, dto, actor);
  }

  // Cancel the draft (edit -> REJ, order back to Released; UG §7.1.7).
  @Post(':id/revisions/draft/reject')
  @RequireProgram('orders.revise')
  rejectRevision(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectRevisionDto, @CurrentUser() actor: Actor) {
    return this.orders.rejectRevision(id, dto, actor);
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

  // Reverse a completed production order (un-complete: CMP -> back to RLS) —
  // un-mints the untouched produced stock, restores the consumed materials,
  // resets the procedure lines, and records a reversing RVSMFP change set.
  @Post(':id/reverse')
  @RequireProgram('orders.reverse')
  reverse(@Param('id', ParseIntPipe) id: number, @Body() dto: ReverseOrderDto, @CurrentUser() actor: Actor) {
    return this.orders.reverse(id, dto, actor);
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

  // Express execution: record every remaining procedure line at standard in
  // one action (FIFO lot selection; shortfalls recorded, never blocking).
  @Post(':id/execution/express')
  @RequireProgram('orders.execute')
  expressExecute(@Param('id', ParseIntPipe) id: number, @Body() dto: ExpressExecuteDto, @CurrentUser() actor: Actor) {
    return this.orders.expressExecute(id, dto, actor);
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

  // The order's native shipment events (packing slips) with lots + reversal state.
  @Get(':id/shipments')
  @RequireProgram('orders.ship')
  shipments(@Param('id', ParseIntPipe) id: number) {
    return this.orders.shipments(id);
  }

  // Reverse ONE shipment event (the legacy RejectWaybill flow, RVSSH): restores
  // the shipped stock where it left, negates the stored movement legs, unwinds
  // QtyUsed, and marks the shipment's lots reversed. Same secured item /
  // perform grant / elevation as the batch reversal.
  @Post(':id/reverse-shipment')
  @RequireProgram('orders.reverse')
  reverseShipment(@Param('id', ParseIntPipe) id: number, @Body() dto: ReverseShipmentDto, @CurrentUser() actor: Actor) {
    return this.orders.reverseShipment(id, dto, actor);
  }
}
