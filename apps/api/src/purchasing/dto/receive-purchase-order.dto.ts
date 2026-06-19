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

export class ReceivePurchaseOrderLineDto {
  /** The PO line (OrdDetail.id) being received against. */
  @IsInt()
  ordDetailId!: number;

  /** Quantity received now (in the line's unit). Over-receipt is allowed. */
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty!: number;

  /** Number of physical containers received (defaults to 1). */
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
