import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApprovalPolicyController } from './approval-policy.controller';
import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalRequestService } from './approval-request.service';

// Approval / workflow engine. For now this owns the per-group approval-policy
// configuration (ApprovalPolicyService); the enforcement trigger on a specific
// action is wired here later. AuditService is global; AuthModule supplies the
// session + program guards.
@Module({
  imports: [AuthModule],
  controllers: [ApprovalPolicyController],
  providers: [ApprovalPolicyService, ApprovalRequestService],
  exports: [ApprovalPolicyService, ApprovalRequestService],
})
export class ApprovalModule {}
