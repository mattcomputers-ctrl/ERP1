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

  @IsOptional()
  @IsString()
  @MaxLength(500)
  witnessExplanation?: string;
}
