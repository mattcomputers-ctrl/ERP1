import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PermissionService } from './permission.service';
import { ProgramGuard } from './program.guard';
import { SessionAuthGuard } from './session-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PermissionService, SessionAuthGuard, ProgramGuard],
  exports: [AuthService, PermissionService, SessionAuthGuard, ProgramGuard],
})
export class AuthModule {}
