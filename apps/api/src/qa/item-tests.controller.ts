import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CreateItemTestDto, UpdateItemTestDto } from './dto/item-test.dto';
import { ItemTestsService } from './item-tests.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('qa.itemTests')
@Controller('item-tests')
export class ItemTestsController {
  constructor(private readonly itemTests: ItemTestsService) {}

  // Item picker (static path before :itemId).
  @Get('item-options')
  itemOptions(@Query('q') q?: string) {
    return this.itemTests.itemOptions(q);
  }

  // Distinct test-name datalist for the editor (static path before :itemId).
  @Get('test-name-options')
  @RequireProgram('qa.itemTestsEdit')
  testNameOptions(@Query('q') q?: string) {
    return this.itemTests.testNameOptions(q);
  }

  @Get(':itemId')
  forItem(@Param('itemId', ParseIntPipe) itemId: number) {
    return this.itemTests.forItem(itemId);
  }

  // --- editing (gated by qa.itemTestsEdit) ---------------------------------

  @Post(':itemId/tests')
  @RequireProgram('qa.itemTestsEdit')
  addTest(@Param('itemId', ParseIntPipe) itemId: number, @Body() dto: CreateItemTestDto, @CurrentUser() actor: Actor) {
    return this.itemTests.addTest(itemId, dto, actor);
  }

  @Patch(':itemId/tests/:testId')
  @RequireProgram('qa.itemTestsEdit')
  updateTest(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Param('testId', ParseIntPipe) testId: number,
    @Body() dto: UpdateItemTestDto,
    @CurrentUser() actor: Actor,
  ) {
    return this.itemTests.updateTest(itemId, testId, dto, actor);
  }

  @Delete(':itemId/tests/:testId')
  @RequireProgram('qa.itemTestsEdit')
  removeTest(@Param('itemId', ParseIntPipe) itemId: number, @Param('testId', ParseIntPipe) testId: number, @CurrentUser() actor: Actor) {
    return this.itemTests.removeTest(itemId, testId, actor);
  }
}
