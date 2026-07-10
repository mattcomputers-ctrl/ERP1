import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { SetPasswordDto } from './dto/set-password.dto';
import { SetUserRolesDto } from './dto/set-roles.dto';
import { SetSsoSubjectDto } from './dto/set-sso-subject.dto';
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

  /** Admin escape hatch for a lost authenticator. */
  @Post(':id/mfa-reset')
  resetMfa(@Param('id') id: string, @CurrentUser() actor: Actor) {
    return this.users.resetMfa(id, actor);
  }

  /** Admin-set password (must change at next login) — gives SSO-only accounts
   * the password that electronic signatures require. */
  @Patch(':id/password')
  setPassword(@Param('id') id: string, @Body() dto: SetPasswordDto, @CurrentUser() actor: Actor) {
    return this.users.setPassword(id, dto.password, actor);
  }

  /** Provision (or unlink) the OIDC subject this user logs in with via SSO. */
  @Patch(':id/sso')
  setSsoSubject(@Param('id') id: string, @Body() dto: SetSsoSubjectDto, @CurrentUser() actor: Actor) {
    return this.users.setSsoSubject(id, dto.ssoSubject, actor);
  }
}
