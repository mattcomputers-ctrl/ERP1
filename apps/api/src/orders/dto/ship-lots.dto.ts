import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
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

export class ShippedLotDto {
  /** The finished-good lot number shipped (off the pick list). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  lot!: string;

  /** Quantity of that lot shipped. NEGATIVE = a customer return — the lot
   * comes back INTO stock and bills as a credit (96 legacy return lines).
   * Zero is refused in the service. */
  @IsNumber()
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  qty!: number;

  /** Unit shipped in (optional; defaults to the line/item unit). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  /** The shipping-order line this lot fulfilled (optional; validated to the order). */
  @IsOptional()
  @IsInt()
  @IsPositive()
  ordDetailId?: number;
}

export class ShipLotsDto {
  /** The finished-good lots shipped on this order (at least one). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShippedLotDto)
  lots!: ShippedLotDto[];

  /** Ship date from the pick list (optional; defaults to now / close time). */
  @IsOptional()
  @IsISO8601()
  shippedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
