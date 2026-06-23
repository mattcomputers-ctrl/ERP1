import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
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

  @Get(':itemId')
  forItem(@Param('itemId', ParseIntPipe) itemId: number) {
    return this.itemTests.forItem(itemId);
  }
}
