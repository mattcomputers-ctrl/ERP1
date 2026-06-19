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

// One on-hand lot of an item. EITHER a raw vendor lot (the system mints an ERP1
// lot number, tagged with the supplier + vendor lot) OR an existing finished-good
// lot number (entered as-is). Exactly one of vendorLot / lotNumber — enforced in
// the service.
export class OpeningLotEntryDto {
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty!: number;

  /** Raw material: the vendor/manufacturer lot — ERP1 mints + assigns the lot number. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  vendorLot?: string;

  /** Raw material: the supplier this vendor lot came from (Entity.id). */
  @IsOptional()
  @IsInt()
  supplierId?: number;

  /** Finished good: the existing ERP1/legacy lot number on hand (entered as-is). */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  lotNumber?: string;
}

export class OpeningLotGroupDto {
  /** Warehouse / location these lots are stored in (Location.id). */
  @IsInt()
  locationId!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OpeningLotEntryDto)
  entries!: OpeningLotEntryDto[];
}

export class EnableLotTrackingDto {
  /** Opening on-hand stock, grouped by location (at least one group). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OpeningLotGroupDto)
  groups!: OpeningLotGroupDto[];
}
