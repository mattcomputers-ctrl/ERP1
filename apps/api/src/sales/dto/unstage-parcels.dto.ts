import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsPositive, ValidateNested } from 'class-validator';

export class UnstageParcelDto {
  /** The reserved assembly parcel to release. */
  @IsInt()
  inventoryId!: number;

  @IsNumber()
  @IsPositive()
  qty!: number;
}

export class UnstageParcelsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => UnstageParcelDto)
  parcels!: UnstageParcelDto[];

  /** Destination stock location; defaults to the receiving dock / install default. */
  @IsOptional()
  @IsInt()
  toLocationId?: number;
}
