import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { SetSecuredItemGrantsDto, UpdateSecuredItemDto } from './dto/secured-item.dto';
import { SecuredItemsService } from './secured-items.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('admin.securedItems')
@Controller('secured-items')
export class SecuredItemsController {
  constructor(private readonly securedItems: SecuredItemsService) {}

  @Get()
  list() {
    return this.securedItems.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.securedItems.get(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSecuredItemDto, @CurrentUser() actor: Actor) {
    return this.securedItems.update(id, dto, actor);
  }

  @Patch(':id/grants')
  setGrants(@Param('id') id: string, @Body() dto: SetSecuredItemGrantsDto, @CurrentUser() actor: Actor) {
    return this.securedItems.setGrants(id, dto, actor);
  }
}
