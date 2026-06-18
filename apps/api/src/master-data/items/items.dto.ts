import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class ItemListQuery {
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
  @IsOptional() @IsString() sort?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() context?: string; // SUNDRY|PP|NAME|PROTOTYPE|PACKAGE
  @IsOptional() @IsString() controlled?: string; // "1" => controlled substances only
}

export class CreateItemDto {
  @IsString() @MaxLength(30) itemCode!: string;
  @IsOptional() @IsString() @MaxLength(256) description?: string;
  @IsOptional() @IsString() @MaxLength(6) unit?: string;
  @IsOptional() @IsString() @MaxLength(32) context?: string;
  @IsOptional() @IsBoolean() controlledSubstance?: boolean;
  @IsOptional() @IsNumber() specificGravity?: number;
}

export class UpdateItemDto {
  @IsOptional() @IsString() @MaxLength(256) description?: string;
  @IsOptional() @IsString() @MaxLength(6) unit?: string;
  @IsOptional() @IsBoolean() controlledSubstance?: boolean;
  @IsOptional() @IsBoolean() certifiedOrganic?: boolean;
  @IsOptional() @IsBoolean() noExpiry?: boolean;
  @IsOptional() @IsNumber() specificGravity?: number;
  @IsOptional() @IsNumber() retestPeriod?: number;
  @IsOptional() @IsString() @MaxLength(4) status?: string;
}
