import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CloseOrderDto } from './dto/close-order.dto';
import { CompleteOrderDto } from './dto/complete-order.dto';
import { CreateOrderDto } from './dto/create-order.dto';
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

  // E-signature requirements for completing an order (drives the complete form).
  @Get('complete-requirement')
  @RequireProgram('orders.complete')
  completeRequirement(@CurrentUser() actor: Actor) {
    return this.orders.completeRequirement(actor.id);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.orders.get(id);
  }

  @Get(':id/batch-sheet')
  batchSheet(@Param('id', ParseIntPipe) id: number) {
    return this.orders.batchSheet(id);
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
}
