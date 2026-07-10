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
} from 'class-validator';

// Supplier price versions (purchase side): the price-version-owning entity IS the
// supplier (PriceVersion.Entity = supplierId; suppliers self-reference their
// PriceList). Each version carries per-item PriceDetails keyed off Item (not the
// sales InvItem). These DTOs drive the supplier price-version editor — the write
// counterpart of the read-only Purchase Price Detail Set Viewer.

export class CreateSupplierPriceVersionDto {
  /** Effective date (ISO 8601). The current version = latest EffectiveDate ≤ now. */
  @IsISO8601()
  effectiveDate!: string;

  /** Optional version number (defaults to the next sequence for the supplier). */
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
// quantity-break tiers; packaging is all-or-nothing (a package type is required
// for qty/unit/price-by-package). Manufacturer pins the offer to a manufacturer
// (0 rows in this install, but the PO line-sourcing read path is manufacturer-aware).
class SupplierPriceDetailFieldsDto {
  @IsOptional() @IsString() @MaxLength(50) entityItemCode?: string;
  @IsOptional() @IsString() @MaxLength(256) description?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;

  /** Package-type item (Item.id whose code is e.g. "DRUM"). */
  @IsOptional() @IsInt() pkgTypeId?: number;
  @IsOptional() @IsNumber() @IsPositive() @Max(1_000_000_000) entityQuantity?: number;
  @IsOptional() @IsString() @MaxLength(20) entityUnit?: string;
  /** When true, the tier prices are per package rather than per unit. */
  @IsOptional() @IsBoolean() priceByPackage?: boolean;

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

  @IsOptional() @IsInt() @Min(0) @Max(100_000) leadTime?: number;
  /** Optional manufacturer pin (Entity.id, IsManufacturer). */
  @IsOptional() @IsInt() manufacturerId?: number;
}

export class CreateSupplierPriceDetailDto extends SupplierPriceDetailFieldsDto {
  /** The stock item this detail prices (Item.id → PriceDetail.Item). */
  @IsInt()
  itemId!: number;
}

export class UpdateSupplierPriceDetailDto extends SupplierPriceDetailFieldsDto {
  /** Optionally re-point the detail at a different item. */
  @IsOptional()
  @IsInt()
  itemId?: number;
}
