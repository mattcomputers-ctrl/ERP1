import { IsEmail, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class CompleteOrderDto {
  @IsOptional()
  @IsNumber()
  actualBatchSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // --- electronic signature (required when the order.complete secured item
  // demands a signature; the service enforces conditional presence) ---

  /** The signer's (current user's) password, re-entered to sign the completion. */
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

  /** Supervisor in-place elevation (L22): credentials of a DIFFERENT user
   * holding the perform grant (or Override) who authorizes this action for a
   * blocked operator. The supervisor becomes the ledger signer. */
  @IsOptional()
  @IsEmail()
  elevatorEmail?: string;

  @IsOptional()
  @IsString()
  elevatorPassword?: string;

  @IsOptional()
  @IsString()
  elevatorTotpCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  witnessExplanation?: string;
}
