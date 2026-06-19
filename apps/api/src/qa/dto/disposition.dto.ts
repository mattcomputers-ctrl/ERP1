import { IsEmail, IsIn, IsISO8601, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

// Legacy Release.Status disposition values.
export const DISPOSITION_STATUSES = ['Approved', 'Hold', 'Rejected'] as const;

export class DispositionDto {
  /** New QA disposition for the lot's release. */
  @IsIn(DISPOSITION_STATUSES as unknown as string[])
  status!: string;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  grade?: string;

  @IsOptional()
  @IsNumber()
  purity?: number;

  /** Optional expiry date (ISO 8601; the UI sends yyyy-mm-dd). */
  @IsOptional()
  @IsISO8601()
  expiryDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // --- electronic signature (required when the release.disposition secured item
  // demands a signature; the service enforces conditional presence) ---

  /** The signer's (current user's) password, re-entered to sign the disposition. */
  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsEmail()
  witnessEmail?: string;

  @IsOptional()
  @IsString()
  witnessPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  witnessExplanation?: string;
}
