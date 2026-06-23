import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CreateRoleDto, SetRoleProgramsDto, UpdateRoleDto } from './dto/role.dto';
import { RolesService } from './roles.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('admin.roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list() {
    return this.roles.list();
  }

  @Post()
  create(@Body() dto: CreateRoleDto, @CurrentUser() actor: Actor) {
    return this.roles.create(dto, actor);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.roles.get(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() actor: Actor) {
    return this.roles.update(id, dto, actor);
  }

  @Patch(':id/programs')
  setPrograms(@Param('id') id: string, @Body() dto: SetRoleProgramsDto, @CurrentUser() actor: Actor) {
    return this.roles.setPrograms(id, dto, actor);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() actor: Actor) {
    return this.roles.remove(id, actor);
  }
}
