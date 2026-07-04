import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateGlGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  glGroup!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}

export class UpdateDescriptionDto {
  // Omitted = keep the current description; explicit null = clear it.
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string | null;
}

export class CreateGlCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  glCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}

export class CreateAccountCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(159)
  accountCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}

export class CreateGlGroupCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  glGroup!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  glCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(159)
  accountCode?: string;
}

export class UpdateGlGroupCodeDto {
  // Explicit null clears the mapping's account. @IsOptional() skips ALL
  // validators on null, so the service re-checks the account exists when set.
  @IsOptional()
  @IsString()
  @MaxLength(159)
  accountCode?: string | null;
}

export class TaxRuleBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  itemTaxGroup?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  entityTaxGroup?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  rate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsBoolean()
  taxOnTax?: boolean;

  @IsInt()
  @Min(1)
  @Max(3)
  taxNumber!: number;
}

export class UpdateTaxRuleDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  itemTaxGroup?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  entityTaxGroup?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  rate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number | null;

  @IsOptional()
  @IsBoolean()
  taxOnTax?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  taxNumber?: number;
}

export class TaxPreviewLineDto {
  @IsInt()
  itemId!: number;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsNumber()
  @Min(0)
  qty!: number;
}

export class TaxPreviewDto {
  @IsInt()
  billToId!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaxPreviewLineDto)
  lines!: TaxPreviewLineDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  freight?: number;
}
