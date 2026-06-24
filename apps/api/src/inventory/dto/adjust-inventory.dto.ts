import { IsInt, IsNumber, IsString, Max, MaxLength, Min } from 'class-validator';

// Adjust an on-hand inventory parcel to a new absolute quantity (a count/
// correction), with a required reason. The quantity is set, not deltaed, so the
// operator enters what was physically counted.
export class AdjustInventoryDto {
  @IsInt()
  inventoryId!: number;

  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  newQty!: number;

  @IsString()
  @MaxLength(500)
  reason!: string;
}
