import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class EntityListQuery {
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
  @IsOptional() @IsString() sort?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() role?: string; // supplier|manufacturer|customer|shipto|salesman|warehouse
}

export class CreateEntityDto {
  @IsString() @MaxLength(20) entityCode!: string;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsBoolean() isSupplier?: boolean;
  @IsOptional() @IsBoolean() isManufacturer?: boolean;
  @IsOptional() @IsBoolean() isBillTo?: boolean;
  @IsOptional() @IsBoolean() isShipTo?: boolean;
  @IsOptional() @IsBoolean() isSalesman?: boolean;
  @IsOptional() @IsBoolean() isWarehouse?: boolean;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(20) terms?: string;
  @IsOptional() @IsString() @MaxLength(20) customerType?: string;
}

export class UpdateEntityDto {
  @IsOptional() @IsBoolean() isSupplier?: boolean;
  @IsOptional() @IsBoolean() isManufacturer?: boolean;
  @IsOptional() @IsBoolean() isBillTo?: boolean;
  @IsOptional() @IsBoolean() isShipTo?: boolean;
  @IsOptional() @IsBoolean() isSalesman?: boolean;
  @IsOptional() @IsBoolean() isWarehouse?: boolean;
  @IsOptional() @IsBoolean() inactive?: boolean;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(20) terms?: string;
  @IsOptional() @IsString() @MaxLength(20) customerType?: string;
  @IsOptional() @IsInt() leadTime?: number;
}
