import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import type { ListQuery } from '../common/list';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CreateInventoryCountDto, EnterCountsDto } from './dto/inventory-count.dto';
import { InventoryCountService } from './inventory-count.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('inventory.count')
@Controller('inventory-counts')
export class InventoryCountController {
  constructor(private readonly counts: InventoryCountService) {}

  @Get()
  list(@Query() query: ListQuery & { posted?: string }) {
    return this.counts.list(query);
  }

  // Pickers for the create form — declared before :id so they aren't swallowed.
  @Get('location-options')
  locationOptions(@Query('q') q?: string) {
    return this.counts.locationOptions(q);
  }

  @Get('item-options')
  itemOptions(@Query('q') q?: string) {
    return this.counts.itemOptions(q);
  }

  @Post()
  create(@Body() dto: CreateInventoryCountDto, @CurrentUser() actor: Actor) {
    return this.counts.createCount(dto, actor);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.counts.get(id);
  }

  @Post(':id/enter')
  enter(@Param('id', ParseIntPipe) id: number, @Body() dto: EnterCountsDto, @CurrentUser() actor: Actor) {
    return this.counts.enterCounts(id, dto, actor);
  }

  @Post(':id/post')
  post(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.counts.postCount(id, actor);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.counts.deleteCount(id, actor);
  }
}
