import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../../auth/program.guard';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import {
  CreateItemDto,
  CreatePackagedProductDto,
  ItemListQuery,
  UpdateItemDto,
  UpdateItemPlanningDto,
} from './items.dto';
import { ItemsService } from './items.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('master.items')
@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  list(@Query() query: ItemListQuery) {
    return this.items.list(query);
  }

  @Get('options')
  options(@Query('q') q?: string, @Query('context') context?: string) {
    return this.items.itemOptions(q, context);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.items.get(id);
  }

  @Post()
  create(@Body() dto: CreateItemDto, @CurrentUser() actor: Actor) {
    return this.items.create(dto, actor);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateItemDto, @CurrentUser() actor: Actor) {
    return this.items.update(id, dto, actor);
  }

  @Get(':id/planning')
  getPlanning(@Param('id', ParseIntPipe) id: number) {
    return this.items.getPlanning(id);
  }

  @Patch(':id/planning')
  updatePlanning(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateItemPlanningDto, @CurrentUser() actor: Actor) {
    return this.items.updatePlanning(id, dto, actor);
  }

  @Get(':id/packaged-products')
  listPackagedProducts(@Param('id', ParseIntPipe) id: number) {
    return this.items.listPackagedProducts(id);
  }

  @Post(':id/packaged-products')
  createPackagedProduct(@Param('id', ParseIntPipe) id: number, @Body() dto: CreatePackagedProductDto, @CurrentUser() actor: Actor) {
    return this.items.createPackagedProduct(id, dto, actor);
  }
}
