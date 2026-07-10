import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../../auth/program.guard';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import {
  CreateAddressDto,
  CreateEntityDto,
  EntityListQuery,
  UpdateAddressDto,
  UpdateEntityDto,
} from './entities.dto';
import { EntitiesService } from './entities.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('master.entities')
@Controller('entities')
export class EntitiesController {
  constructor(private readonly entities: EntitiesService) {}

  @Get()
  list(@Query() query: EntityListQuery) {
    return this.entities.list(query);
  }

  @Get('options')
  options(@Query('q') q?: string, @Query('role') role?: string) {
    return this.entities.entityOptions(q, role);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.entities.get(id);
  }

  @Post()
  create(@Body() dto: CreateEntityDto, @CurrentUser() actor: Actor) {
    return this.entities.create(dto, actor);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEntityDto, @CurrentUser() actor: Actor) {
    return this.entities.update(id, dto, actor);
  }

  @Post(':id/addresses')
  addAddress(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateAddressDto, @CurrentUser() actor: Actor) {
    return this.entities.addAddress(id, dto, actor);
  }

  @Patch(':id/addresses/:addressId')
  updateAddress(
    @Param('id', ParseIntPipe) id: number,
    @Param('addressId', ParseIntPipe) addressId: number,
    @Body() dto: UpdateAddressDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.entities.updateAddress(id, addressId, dto, actor);
  }

  @Delete(':id/addresses/:addressId')
  removeAddress(
    @Param('id', ParseIntPipe) id: number,
    @Param('addressId', ParseIntPipe) addressId: number,
    @CurrentUser() actor: Actor,
  ) {
    return this.entities.removeAddress(id, addressId, actor);
  }
}
