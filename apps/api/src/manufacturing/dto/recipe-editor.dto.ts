import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber,
  IsOptional, IsPositive, IsString, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';

// Production recipe contexts (legacy Recipe.Context): RMBA batching, RMPP packaging.
export const EDITABLE_RECIPE_CONTEXTS = ['RMBA', 'RMPP'] as const;

export class CreateRecipeDto {
  @IsIn(EDITABLE_RECIPE_CONTEXTS as unknown as string[])
  context!: string;

  /** The recipe number (legacy VarChar(20)); revisions use a `.NN` suffix. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  recipeNumber!: string;

  /** The produced item (the PK line). */
  @IsInt()
  @Min(1)
  productItemId!: number;

  /** The recipe comment — vendor-required; doubles as the revision note. */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  comment!: string;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  weightUnit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  volumeUnit?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  leadTime?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  reference?: string;

  @IsOptional()
  @IsBoolean()
  rework?: boolean;
}

export class CloneRecipeDto {
  /** Explicit number for the new version; omitted → next `BASE.NN` suggested. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  recipeNumber?: string;

  /** Revision note for the new version (defaults to the source's comment). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export class UpdateRecipeHeaderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  recipeNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  reference?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  leadTime?: number;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  weightUnit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  volumeUnit?: string;

  @IsOptional()
  @IsBoolean()
  rework?: boolean;

  /** Re-point the product (PK) line at a different item. */
  @IsOptional()
  @IsInt()
  @Min(1)
  productItemId?: number;
}

export const PROCEDURE_LINE_KINDS = ['ingredient', 'instruction'] as const;
export type ProcedureLineKind = (typeof PROCEDURE_LINE_KINDS)[number];

export class ProcedureLineDto {
  /** Existing RecipeDetail id (update in place); omitted → new line. */
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;

  @IsIn(PROCEDURE_LINE_KINDS as unknown as string[])
  kind!: ProcedureLineKind;

  /** Ingredient item (required for kind=ingredient). */
  @IsOptional()
  @IsInt()
  @Min(1)
  itemId?: number;

  /** Ingredient quantity at the payload's formula basis (required for ingredients). */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty?: number;

  /** Instruction text (required for kind=instruction); optional note on ingredients. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}

export class SaveProcedureDto {
  /**
   * The formula basis the payload quantities are expressed at (e.g. 100 = the
   * user typed pounds-per-100-lb-batch). Stored quantities are normalized to
   * per-1-lb (qty ÷ basis) — the legacy convention on 5,650 of 5,652 active
   * batching recipes.
   */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  basis?: number;

  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ProcedureLineDto)
  lines!: ProcedureLineDto[];
}

export class PublishRecipeDto {
  /** Reason / explanation (required when the secured item demands one). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // --- electronic signature (required when the recipe.publish secured item
  // demands a signature; the service enforces conditional presence) ---

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

export class SetRecipeActiveDto {
  @IsBoolean()
  active!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
