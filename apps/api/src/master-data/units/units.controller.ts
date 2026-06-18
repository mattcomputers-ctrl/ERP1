import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../../auth/program.guard';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { CreateUnitDto, UnitListQuery, UpdateUnitDto } from './units.dto';
import { UnitsService } from './units.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('master.units')
@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  list(@Query() query: UnitListQuery) {
    return this.units.list(query);
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.units.get(code);
  }

  @Post()
  create(@Body() dto: CreateUnitDto, @CurrentUser() actor: Actor) {
    return this.units.create(dto, actor);
  }

  @Patch(':code')
  update(@Param('code') code: string, @Body() dto: UpdateUnitDto, @CurrentUser() actor: Actor) {
    return this.units.update(code, dto, actor);
  }
}
