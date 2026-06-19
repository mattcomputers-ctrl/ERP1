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
  ValidateNested,
} from 'class-validator';

export class ConsumedItemQtyDto {
  /** The (not-lot-traced) item consumed — depleted FIFO across its lots. */
  @IsInt()
  @IsPositive()
  itemId!: number;

  /** Quantity of that item consumed. */
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty!: number;
}

export class ConsumeQtyDto {
  /** The items (by quantity) this batch consumed FIFO (at least one). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ConsumedItemQtyDto)
  items!: ConsumedItemQtyDto[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
