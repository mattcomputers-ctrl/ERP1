import { IsInt, IsNumber, IsPositive, IsString, IsOptional, Max, MaxLength } from 'class-validator';

// Move a quantity of an on-hand parcel to another location. The remainder stays
// at the source; the moved quantity merges into (or creates) a parcel of the same
// item + lot at the destination.
export class TransferInventoryDto {
  @IsInt()
  inventoryId!: number;

  @IsInt()
  toLocationId!: number;

  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
