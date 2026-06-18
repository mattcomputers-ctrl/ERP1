import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AuditService } from './audit.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('admin.audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query('take') take?: string, @Query('skip') skip?: string) {
    return this.audit.list({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get('verify')
  verify() {
    return this.audit.verifyChain();
  }
}
