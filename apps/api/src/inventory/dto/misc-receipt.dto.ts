import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// A miscellaneous (non-PO) inventory receipt: stock created without a purchase
// order — opening balances, found stock, samples in, adjustments-in. Each line
// mints a system lot (raw-material sequence) + sublot + on-hand. Unlike PO
// receiving there is no supplier, so the manufacturer lot is OPTIONAL.
export class MiscReceiptLineDto {
  /** Item received (Item.id). */
  @IsInt()
  itemId!: number;

  /** Quantity received (in the line's unit). */
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty!: number;

  /** Unit of measure; defaults to the item's stock unit. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  /** Optional manufacturer/supplier lot number — when given it becomes the
   * recall key (so the lot is findable by a manufacturer-lot search). */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  manufacturerLot?: string;

  /** Optional per-unit cost to value the received lot. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  unitCost?: number;

  /** Number of physical containers (defaults to 1). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  numberOfContainers?: number;
}

export class CreateMiscReceiptDto {
  /** Lines received (at least one). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MiscReceiptLineDto)
  lines!: MiscReceiptLineDto[];

  /** Optional reason / reference (recorded in the audit trail). */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  reference?: string;
}
