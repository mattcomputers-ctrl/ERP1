import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';

// Edit a secured item's response level (operator-tunable). Only the supplied
// flags change.
export class UpdateSecuredItemDto {
  @IsOptional()
  @IsBoolean()
  requireReason?: boolean;

  @IsOptional()
  @IsBoolean()
  requireSignature?: boolean;

  @IsOptional()
  @IsBoolean()
  requireWitness?: boolean;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

export class SecuredItemGrantDto {
  @IsString()
  roleCode!: string;

  /** May the group PERFORM the secured action. */
  @IsOptional()
  @IsBoolean()
  allow?: boolean;

  /** May the group act as a WITNESS for the action. */
  @IsOptional()
  @IsBoolean()
  allowWitness?: boolean;
}

// Replace the role grants for a secured item (entries with neither flag set are
// dropped).
export class SetSecuredItemGrantsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SecuredItemGrantDto)
  grants!: SecuredItemGrantDto[];
}
