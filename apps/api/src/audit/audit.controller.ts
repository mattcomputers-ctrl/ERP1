import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AuditService } from './audit.service';
import { ESignatureService } from './esignature.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('admin.audit')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly esign: ESignatureService,
  ) {}

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

  // Electronic-signature ledger (append-only, hash-chained) + its integrity check.
  @Get('signatures')
  signatures(@Query('take') take?: string, @Query('skip') skip?: string) {
    return this.esign.list({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get('signatures/verify')
  verifySignatures() {
    return this.esign.verifyChain();
  }
}
