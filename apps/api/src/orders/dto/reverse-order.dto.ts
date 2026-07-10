import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReverseOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // --- electronic signature (required when the order.reverse secured item
  // demands a signature; the service enforces conditional presence) ---

  /** The signer's (current user's) password, re-entered to sign the reversal. */
  @IsOptional()
  @IsString()
  password?: string;

  /** Optional second-person witness credentials. */
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
