import { IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from 'class-validator';

// Update an existing line on a not-yet-released purchase order. All fields
// optional — only the provided ones change. (Adding a line reuses
// CreatePurchaseOrderLineDto; the item of an existing line is not re-pointed —
// remove + add to change the item.)
export class UpdatePurchaseOrderLineDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qtyReqd?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}
