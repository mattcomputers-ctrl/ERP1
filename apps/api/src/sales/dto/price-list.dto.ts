import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// A sales price list is an Entity flagged IsPriceList; customers reference it via
// Entity.PriceList. It owns effective-dated PriceVersions, each carrying per-item
// PriceDetails. These DTOs drive the read+write price-list editor.

export class CreatePriceListDto {
  /** Display name (stored on the price-list entity's Address). */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  /** Optional short code (Entity.EntityCode, unique). Auto-generated when omitted. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  code?: string;
}

export class CreatePriceVersionDto {
  /** Effective date (ISO 8601). The current version = latest EffectiveDate ≤ now. */
  @IsISO8601()
  effectiveDate!: string;

  /** Optional version number (defaults to the next sequence for the list). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  version?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

// Shared, optional price-detail fields (used by create + update). Up to five
// quantity-break tiers; packaging mirrors the supplier side.
class PriceDetailFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  entityItemCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  /** Package-type item (Item.id whose code is e.g. "DRUM"). */
  @IsOptional()
  @IsInt()
  pkgTypeId?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  entityQuantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  entityUnit?: string;

  /** When true, the tier prices are per package rather than per unit. */
  @IsOptional()
  @IsBoolean()
  priceByPackage?: boolean;

  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) minOrder1?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) price1?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) minOrder2?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) price2?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) minOrder3?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) price3?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) minOrder4?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) price4?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) minOrder5?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) price5?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  leadTime?: number;
}

export class CreatePriceDetailDto extends PriceDetailFieldsDto {
  /** The stock item this detail prices (Item.id → PriceDetail.InvItem). */
  @IsInt()
  invItemId!: number;
}

export class UpdatePriceDetailDto extends PriceDetailFieldsDto {
  /** Optionally re-point the detail at a different stock item. */
  @IsOptional()
  @IsInt()
  invItemId?: number;
}

export class AssignCustomerDto {
  /** The customer (Entity.id, IsBillTo or IsShipTo) to put on this price list. */
  @IsInt()
  customerId!: number;
}
