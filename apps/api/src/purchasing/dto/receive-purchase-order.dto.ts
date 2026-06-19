import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// One received lot of an item: a quantity tagged with the supplier's
// (manufacturer's) lot number, which is required so we can run a recall by
// manufacturer lot. Each lot is assigned its own sequential system lot number
// at receiving.
export class ReceiveLotDto {
  /** Quantity received in this lot (in the line's unit). Over-receipt is allowed. */
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty!: number;

  /** Manufacturer's / supplier's lot number — REQUIRED (recall key). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  manufacturerLot!: string;

  /** Number of physical containers in this lot (defaults to 1). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  numberOfContainers?: number;

  /** Unit of measure; defaults to the line's unit. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;
}

export class ReceivePurchaseOrderLineDto {
  /** The PO line (OrdDetail.id) being received against. */
  @IsInt()
  ordDetailId!: number;

  /** One or more lots received for this line (split a line across lots here). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLotDto)
  lots!: ReceiveLotDto[];
}

export class ReceivePurchaseOrderDto {
  /** Lines received in this receipt (at least one). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceivePurchaseOrderLineDto)
  lines!: ReceivePurchaseOrderLineDto[];

  /** Optional packing-slip / receipt reference (recorded in the audit trail). */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  reference?: string;
}
