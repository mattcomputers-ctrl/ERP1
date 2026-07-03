import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ConsumedLotDto } from './consume-lots.dto';

/**
 * Record execution of one order line (guided batch execution). A material (UI)
 * line takes the actual dispensed quantity — zero means the ingredient was
 * skipped — plus, when the item is lot-traced, the specific lots dispensed
 * (their quantities must sum to the actual). An instruction line takes no
 * fields (a check-off).
 */
export class RecordLineDto {
  /** Actual quantity dispensed/added (material lines; >= 0, 0 = skipped). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  actualQty?: number;

  /** The specific lots dispensed (required iff the line's item is lot-traced). */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ConsumedLotDto)
  lots?: ConsumedLotDto[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
