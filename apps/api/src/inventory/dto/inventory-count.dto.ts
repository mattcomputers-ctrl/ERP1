import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// Create an inventory count sheet: snapshot the on-hand parcels matching the
// scope (a location, optionally narrowed to one item and/or a status) into a
// draft (unposted) count. ERP1 counts per-parcel — its lot-traced grain — unlike
// legacy which counted at item+location aggregate (Sublot NULL on all rows).
export class CreateInventoryCountDto {
  /** The location to count (Location.id). */
  @IsInt()
  locationId!: number;

  /** Optional: narrow the count to a single item (Item.id). */
  @IsOptional()
  @IsInt()
  itemId?: number;

  /** Optional: narrow to parcels of a given inventory status (Inventory.Status). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}

export class CountEntryDto {
  /** The count line (InventoryCountDetail.id) to set. */
  @IsInt()
  detailId!: number;

  /** The counted quantity for the parcel; null clears it back to uncounted. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  countedQty?: number | null;
}

// Enter counted quantities on a draft count (bulk). Only unposted counts accept it.
export class EnterCountsDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => CountEntryDto)
  counts!: CountEntryDto[];
}
