import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ItemListQuery {
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
  @IsOptional() @IsString() sort?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() context?: string; // SUNDRY|PP|NAME|PROTOTYPE|PACKAGE
  @IsOptional() @IsString() controlled?: string; // "1" => controlled substances only
}

export class CreateItemDto {
  @IsString() @MaxLength(30) itemCode!: string;
  @IsOptional() @IsString() @MaxLength(256) description?: string;
  @IsOptional() @IsString() @MaxLength(6) unit?: string;
  @IsOptional() @IsString() @MaxLength(32) context?: string;
  @IsOptional() @IsBoolean() controlledSubstance?: boolean;
  @IsOptional() @IsNumber() specificGravity?: number;
  // A NAME-alias item (context NAME) points at the real stock item it aliases
  // via ReplacedBy — the plant's daily new-product flow (Item Name Update).
  @IsOptional() @IsInt() replacedById?: number;
}

export class UpdateItemDto {
  @IsOptional() @IsString() @MaxLength(256) description?: string;
  @IsOptional() @IsString() @MaxLength(6) unit?: string;
  @IsOptional() @IsBoolean() controlledSubstance?: boolean;
  @IsOptional() @IsBoolean() certifiedOrganic?: boolean;
  @IsOptional() @IsBoolean() noExpiry?: boolean;
  @IsOptional() @IsNumber() specificGravity?: number;
  @IsOptional() @IsNumber() retestPeriod?: number;
  @IsOptional() @IsString() @MaxLength(4) status?: string;
  // Nullable: pass null to clear an alias link (re-asserted in the service since
  // @IsOptional skips validators on explicit null).
  @IsOptional() @IsInt() replacedById?: number | null;
}

// ItemEntity ST-row planning knobs (min stock / lead times). The planning engine
// reads these; nothing natively edited them before. All nullable so a cleared
// field removes the value rather than silently zeroing it.
export class UpdateItemPlanningDto {
  @IsOptional() @IsNumber() @Min(0) minimumStock?: number | null;
  @IsOptional() @IsInt() @Min(0) leadTime?: number | null;
  @IsOptional() @IsInt() @Min(0) testingLeadTime?: number | null;
}

// Make a bulk item's packaged product orderable (ItemPackagedProduct binding:
// bulk item + packaging prototype -> packaged-product item, packed by an RMPP
// recipe resolved to its active revision at read time).
export class CreatePackagedProductDto {
  @IsInt() packagingPrototypeId!: number;
  @IsInt() packagedProductId!: number;
  // Optional: pin a specific RMPP recipe. Left unset, the packout resolution
  // finds the active RMPP revision producing the packaged product at read time.
  @IsOptional() @IsInt() recipeId?: number;
}
