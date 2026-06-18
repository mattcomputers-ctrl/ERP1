import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PermissionService } from './permission.service';

export const PROGRAM_KEY = 'required_program';

/** Restrict a route/controller to users whose roles grant the given program. */
export const RequireProgram = (key: string) => SetMetadata(PROGRAM_KEY, key);

@Injectable()
export class ProgramGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const programKey = this.reflector.getAllAndOverride<string | undefined>(PROGRAM_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!programKey) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.session?.userId) throw new UnauthorizedException('Authentication required');

    const allowed = await this.permissions.userHasProgram(req.session.userId, programKey);
    if (!allowed) {
      throw new ForbiddenException(`You do not have permission for "${programKey}"`);
    }
    return true;
  }
}
