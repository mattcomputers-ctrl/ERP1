import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ViewersService, type ViewerRowsQuery } from './viewers.service';

/**
 * §18 set viewers: one generic surface for the whole registry. Per-viewer
 * program access is enforced in the service (a single dynamic :id route
 * serves every viewer, so @RequireProgram metadata can't express it).
 */
@UseGuards(SessionAuthGuard)
@Controller('viewers')
export class ViewersController {
  constructor(private readonly viewers: ViewersService) {}

  @Get()
  list(@CurrentUser() actor: Actor) {
    return this.viewers.list(actor.id);
  }

  @Get(':id')
  meta(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.viewers.meta(actor.id, id);
  }

  @Get(':id/rows')
  rows(@CurrentUser() actor: Actor, @Param('id') id: string, @Query() query: ViewerRowsQuery) {
    return this.viewers.rows(actor.id, id, query);
  }

  // Full-set CSV download (the legacy set viewers export everything, not the
  // visible page). Same filters/sort as the grid.
  @Get(':id/export')
  async export(
    @CurrentUser() actor: Actor,
    @Param('id') id: string,
    @Query() query: ViewerRowsQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { fileName, content } = await this.viewers.exportCsv(actor.id, id, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return content;
  }
}
