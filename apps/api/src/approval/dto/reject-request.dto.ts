import { IsString, MaxLength } from 'class-validator';

// Reject a pending approval request (reason required; audited). Shared by the
// blocking-workflow consumers (PO / SH line edits).
export class RejectApprovalRequestDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}
