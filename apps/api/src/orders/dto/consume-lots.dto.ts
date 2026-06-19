import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ConsumedLotDto {
  /** The raw-material (or input) lot number consumed into the batch. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  lot!: string;

  /** Quantity of that lot consumed. */
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty!: number;
}

export class ConsumeLotsDto {
  /** The input lots this batch consumed (at least one). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ConsumedLotDto)
  lots!: ConsumedLotDto[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
