import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

// Approve a pending QA-disposition request — enacts the requested change on the
// Release. Carries the approver's electronic signature (required when the
// release.disposition secured item demands one; the service enforces presence).
export class ApproveDispositionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** The approver's password, re-entered to sign the approval. */
  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsEmail()
  witnessEmail?: string;

  @IsOptional()
  @IsString()
  witnessPassword?: string;

  /** Signer's TOTP code — demanded when the signer is MFA-enrolled. */
  @IsOptional()
  @IsString()
  totpCode?: string;

  /** Witness's TOTP code — demanded when the witness is MFA-enrolled. */
  @IsOptional()
  @IsString()
  witnessTotpCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  witnessExplanation?: string;
}

// Reject a pending QA-disposition request — the Release is left unchanged. A
// reason is required (the service rejects a blank one) and is audited.
export class RejectDispositionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}
