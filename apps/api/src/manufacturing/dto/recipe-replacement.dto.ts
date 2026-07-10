import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsInt, IsOptional, IsString, MaxLength, Min,
} from 'class-validator';

export class RunReplacementDto {
  /** The ingredient being replaced. */
  @IsInt()
  @Min(1)
  fromItemId!: number;

  /** The replacement ingredient. */
  @IsInt()
  @Min(1)
  toItemId!: number;

  /** The recipes to revise (from the preview). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Min(1, { each: true })
  recipeIds!: number[];

  /** Job description — becomes the new revisions' comment (revision note). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Publish each new revision immediately (deactivating the superseded one).
   * When false, the revisions are left as drafts for review. */
  @IsOptional()
  @IsBoolean()
  publish?: boolean;

  // --- publish gate (used when publish=true and the recipe.publish secured
  // item requires a reason / signature / witness) ---

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

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
