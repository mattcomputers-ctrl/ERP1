import { IsBoolean, IsOptional } from 'class-validator';

// Set a user group's (Role's) approval policy. Every capability is optional — a
// PUT updates only the flags supplied and leaves the rest at the group's current
// effective value (so a single-toggle UI can send just one field).
export class SetApprovalPolicyDto {
  @IsOptional()
  @IsBoolean()
  canRequestApproval?: boolean;

  @IsOptional()
  @IsBoolean()
  canApprove?: boolean;

  @IsOptional()
  @IsBoolean()
  canApproveUpdate?: boolean;

  @IsOptional()
  @IsBoolean()
  canApproveChange?: boolean;

  @IsOptional()
  @IsBoolean()
  canOverride?: boolean;

  @IsOptional()
  @IsBoolean()
  noApprovalRequired?: boolean;
}
