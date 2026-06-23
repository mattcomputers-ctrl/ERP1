import { IsString, MaxLength } from 'class-validator';

// Reject a pending order-edit approval request (reason required; audited).
export class RejectEditApprovalDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}
