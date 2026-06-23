import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { SetUserRolesDto } from './dto/set-roles.dto';
import { SetStatusDto } from './dto/set-status.dto';
import { UsersService } from './users.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('admin.users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: Actor) {
    return this.users.create(dto, actor);
  }

  // Role picker for the user editor (declared before :id routes).
  @Get('role-options')
  roleOptions() {
    return this.users.roleOptions();
  }

  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetStatusDto, @CurrentUser() actor: Actor) {
    return this.users.setStatus(id, dto.status, actor);
  }

  @Patch(':id/roles')
  setRoles(@Param('id') id: string, @Body() dto: SetUserRolesDto, @CurrentUser() actor: Actor) {
    return this.users.setRoles(id, dto, actor);
  }
}
