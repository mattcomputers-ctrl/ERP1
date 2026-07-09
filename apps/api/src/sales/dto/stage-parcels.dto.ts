import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsPositive, ValidateNested } from 'class-validator';

export class StageParcelDto {
  /** Source on-hand parcel (free stock — not reserved, not SMP/ASM). */
  @IsInt()
  inventoryId!: number;

  /** The SH order line this quantity is reserved to. */
  @IsInt()
  ordDetailId!: number;

  @IsNumber()
  @IsPositive()
  qty!: number;
}

export class StageParcelsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => StageParcelDto)
  parcels!: StageParcelDto[];
}
