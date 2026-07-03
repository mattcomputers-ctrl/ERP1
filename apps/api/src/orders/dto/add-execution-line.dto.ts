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
import { ConsumedLotDto } from './consume-lots.dto';

/**
 * A batch addition: an ingredient added during execution that wasn't on the
 * recipe (legacy did exactly this — extra UI lines appended to released orders
 * with the actual quantity added). Recorded already-executed: the line is born
 * with QtyReqd = QtyUsed = the actual quantity and consumed immediately.
 */
export class AddExecutionLineDto {
  @IsInt()
  itemId!: number;

  /** Actual quantity added. */
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty!: number;

  /** The specific lots added (required iff the item is lot-traced). */
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
