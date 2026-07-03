import {
  Body, Controller, Delete, Get, Param, ParseFloatPipe, ParseIntPipe, Patch, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import type { ListQuery } from '../common/list';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import {
  CloneRecipeDto, CreateRecipeDto, PublishRecipeDto, SaveProcedureDto,
  SetRecipeActiveDto, UpdateRecipeHeaderDto,
} from './dto/recipe-editor.dto';
import { RunReplacementDto } from './dto/recipe-replacement.dto';
import { RecipeEditorService } from './recipe-editor.service';
import { RecipeReplacementService } from './recipe-replacement.service';
import { RecipesService } from './recipes.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('recipe.manager')
@Controller('recipes')
export class RecipesController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly editor: RecipeEditorService,
    private readonly replacement: RecipeReplacementService,
  ) {}

  @Get()
  list(@Query() query: ListQuery & { context?: string; published?: string; state?: string }) {
    return this.recipes.list(query);
  }

  // Item typeahead for the editor (static path before :id).
  @Get('item-options')
  @RequireProgram('recipe.editor')
  itemOptions(@Query('q') q?: string) {
    return this.recipes.itemOptions(q);
  }

  // --- ingredient replacement (the legacy Recipe Replacement tool) ---------

  /** Active published recipes an ingredient replacement would touch. */
  @Get('replacement/preview')
  @RequireProgram('recipe.editor')
  replacementPreview(@Query('fromItemId', ParseIntPipe) fromItemId: number) {
    return this.replacement.preview(fromItemId);
  }

  /** Run a replacement job: per selected recipe, clone → swap → (publish). */
  @Post('replacement')
  @RequireProgram('recipe.editor')
  runReplacement(@Body() dto: RunReplacementDto, @CurrentUser() actor: Actor) {
    return this.replacement.run(dto, actor);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.recipes.get(id);
  }

  /** Batch-record preview at a chosen batch size (no order, no lot). */
  @Get(':id/preview')
  preview(
    @Param('id', ParseIntPipe) id: number,
    @Query('batchSize', new ParseFloatPipe({ optional: true })) batchSize?: number,
  ) {
    return this.recipes.preview(id, batchSize ?? 100);
  }

  /** Expected-cost rollup (vendor §5.3.1) at a chosen batch size. Exposes
   * supplier purchase pricing, so it carries the same program that gates the
   * Purchase Price Detail viewer — not just recipe browsing. */
  @Get(':id/pricing')
  @RequireProgram('purchasing.priceDetails')
  pricing(
    @Param('id', ParseIntPipe) id: number,
    @Query('batchSize', new ParseFloatPipe({ optional: true })) batchSize?: number,
  ) {
    return this.recipes.pricing(id, batchSize ?? 100);
  }

  /** Standalone Verify — the checklist publish will enforce. */
  @Get(':id/verify')
  @RequireProgram('recipe.editor')
  async verify(@Param('id', ParseIntPipe) id: number) {
    return { errors: await this.editor.verify(id) };
  }

  /** The publish response requirements (reason / signature / witness) for the
   * current user — drives the publish dialog. */
  @Get(':id/publish-requirement')
  @RequireProgram('recipe.editor')
  publishRequirement(@CurrentUser() actor: Actor) {
    return this.editor.publishRequirement(actor.id);
  }

  // --- editing (gated by recipe.editor) ------------------------------------

  @Post()
  @RequireProgram('recipe.editor')
  create(@Body() dto: CreateRecipeDto, @CurrentUser() actor: Actor) {
    return this.editor.create(dto, actor);
  }

  @Post(':id/clone')
  @RequireProgram('recipe.editor')
  clone(@Param('id', ParseIntPipe) id: number, @Body() dto: CloneRecipeDto, @CurrentUser() actor: Actor) {
    return this.editor.clone(id, dto, actor);
  }

  @Patch(':id')
  @RequireProgram('recipe.editor')
  updateHeader(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRecipeHeaderDto, @CurrentUser() actor: Actor) {
    return this.editor.updateHeader(id, dto, actor);
  }

  @Put(':id/procedure')
  @RequireProgram('recipe.editor')
  saveProcedure(@Param('id', ParseIntPipe) id: number, @Body() dto: SaveProcedureDto, @CurrentUser() actor: Actor) {
    return this.editor.saveProcedure(id, dto, actor);
  }

  @Post(':id/publish')
  @RequireProgram('recipe.editor')
  publish(@Param('id', ParseIntPipe) id: number, @Body() dto: PublishRecipeDto, @CurrentUser() actor: Actor) {
    return this.editor.publish(id, dto, actor);
  }

  @Post(':id/active')
  @RequireProgram('recipe.editor')
  setActive(@Param('id', ParseIntPipe) id: number, @Body() dto: SetRecipeActiveDto, @CurrentUser() actor: Actor) {
    return this.editor.setActive(id, dto, actor);
  }

  @Delete(':id')
  @RequireProgram('recipe.editor')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.editor.remove(id, actor);
  }
}
