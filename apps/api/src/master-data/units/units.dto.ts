import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class UnitListQuery {
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
  @IsOptional() @IsString() sort?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() category?: string;
}

export class CreateUnitDto {
  @IsString() @MaxLength(6) code!: string;
  @IsString() @MaxLength(256) description!: string;
  @IsOptional() @IsString() @MaxLength(6) category?: string;
  @IsOptional() @IsString() @MaxLength(6) baseUnit?: string;
  @IsOptional() @IsNumber() baseQty?: number;
}

export class UpdateUnitDto {
  @IsOptional() @IsString() @MaxLength(256) description?: string;
  @IsOptional() @IsString() @MaxLength(6) category?: string;
  @IsOptional() @IsString() @MaxLength(6) baseUnit?: string;
  @IsOptional() @IsNumber() baseQty?: number;
  @IsOptional() @IsBoolean() showOnScreen?: boolean;
}
