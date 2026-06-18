import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../../auth/program.guard';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { CreateEntityDto, EntityListQuery, UpdateEntityDto } from './entities.dto';
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
}
