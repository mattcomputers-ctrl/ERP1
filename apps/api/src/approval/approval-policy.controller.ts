import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ApprovalPolicyService } from './approval-policy.service';
import { SetApprovalPolicyDto } from './dto/set-approval-policy.dto';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('admin.approvalPolicies')
@Controller('approval-policies')
export class ApprovalPolicyController {
  constructor(private readonly policies: ApprovalPolicyService) {}

  // Every user group with its effective approval policy.
  @Get()
  list() {
    return this.policies.list();
  }

  // Update a group's approval policy (partial — only the supplied capabilities).
  @Patch(':roleId')
  set(@Param('roleId') roleId: string, @Body() dto: SetApprovalPolicyDto, @CurrentUser() actor: Actor) {
    return this.policies.set(roleId, dto, actor);
  }
}
