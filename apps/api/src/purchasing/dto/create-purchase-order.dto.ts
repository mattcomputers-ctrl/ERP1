import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreatePurchaseOrderLineDto {
  /** Item being purchased (Item.id). */
  @IsInt()
  itemId!: number;

  /** Quantity ordered, in the line's unit. */
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qtyReqd!: number;

  /** Unit purchase price (per unit). Optional — some POs are priced later. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  price?: number;

  /** Unit of measure (e.g. LB, KG). Defaults to the item's stock unit. */
  @IsOptional()
  @IsString()
  @MaxLength(6)
  unit?: string;

  /** Optional line description; defaults to the item's description. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  /** Required manufacturer (Entity.id) — the received goods must be made by
   * this manufacturer (OrdDetail.Manufacturer; planning matches PO supply to
   * manufacturer-pinned demand through it). */
  @IsOptional()
  @IsInt()
  manufacturerId?: number;
}

export class CreatePurchaseOrderDto {
  /** Supplier entity (Entity.id, isSupplier). Becomes Ordr.Entity. */
  @IsInt()
  supplierId!: number;

  /** PO lines (at least one). Bounded above to reject runaway payloads. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderLineDto)
  lines!: CreatePurchaseOrderLineDto[];

  /** Optional required/due date (ISO 8601; the UI sends yyyy-mm-dd). */
  @IsOptional()
  @IsISO8601()
  dateRequired?: string;

  /** Optional free-text reference (Ordr.Reference). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  reference?: string;

  /** Optional external PO number (Ordr.PoNumber); defaults to the order id. */
  @IsOptional()
  @IsString()
  @MaxLength(25)
  poNumber?: string;

  /** Optional payment terms code (Ordr.Terms → Terms.code). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  terms?: string;

  /** Optional incoterms / FOB text (Ordr.Incoterms). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  incoterms?: string;

  /** Optional carrier (Entity.id, ShipVia). Becomes Ordr.ShipVia. */
  @IsOptional()
  @IsInt()
  shipViaId?: number;
}
