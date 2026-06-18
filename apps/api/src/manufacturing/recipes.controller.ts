import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import type { ListQuery } from '../common/list';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { RecipesService } from './recipes.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('recipe.manager')
@Controller('recipes')
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get()
  list(@Query() query: ListQuery & { context?: string; published?: string }) {
    return this.recipes.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.recipes.get(id);
  }
}
