import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
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

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.orders.get(id);
  }
}
