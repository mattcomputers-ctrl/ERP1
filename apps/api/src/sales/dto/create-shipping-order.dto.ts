import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ShippingLineDto {
  @IsInt()
  @IsPositive()
  itemId!: number;

  /** Quantity ordered (to ship). */
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qtyReqd!: number;

  /** Unit sale price (optional). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  price?: number;

  // OrdDetail.EntityUnit is VarChar(6) — keep the bound at the column width.
  @IsOptional()
  @IsString()
  @MaxLength(6)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}

export class CreateShippingOrderDto {
  /** The customer being billed (an IsBillTo entity). */
  @IsInt()
  @IsPositive()
  billToId!: number;

  /** Where it ships (an IsShipTo entity); defaults to the BillTo. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  shipToId?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  salesmanId?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  shipViaId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  terms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  incoterms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  /** The customer's PO number. */
  @IsOptional()
  @IsString()
  @MaxLength(25)
  poNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  reference?: string;

  @IsOptional()
  @IsISO8601()
  dateRequired?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShippingLineDto)
  lines!: ShippingLineDto[];
}
