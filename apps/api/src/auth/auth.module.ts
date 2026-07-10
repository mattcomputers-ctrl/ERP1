import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ElevationService } from './elevation.service';
import { OidcProviderService } from './oidc-provider.service';
import { PermissionService } from './permission.service';
import { ProgramGuard } from './program.guard';
import { SessionAuthGuard } from './session-auth.guard';
import { SsoService } from './sso.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PermissionService, SessionAuthGuard, ProgramGuard, OidcProviderService, SsoService, ElevationService],
  exports: [AuthService, PermissionService, SessionAuthGuard, ProgramGuard, ElevationService],
})
export class AuthModule {}
