import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Create a test requirement (ItemTest) for an item — a QC spec (min/max/target or
// free-text specification) at one or more stages (receipt / production / retest).
// These rows drive native order QC specs and the CofA.
export class CreateItemTestDto {
  @IsString()
  @MaxLength(20)
  test!: string;

  @IsOptional() @IsString() @MaxLength(20)
  testGroup?: string;

  @IsOptional() @IsString() @MaxLength(40)
  qualifier?: string;

  @IsOptional() @IsNumber() @Min(-1_000_000_000) @Max(1_000_000_000)
  min?: number;

  @IsOptional() @IsNumber() @Min(-1_000_000_000) @Max(1_000_000_000)
  max?: number;

  @IsOptional() @IsNumber() @Min(-1_000_000_000) @Max(1_000_000_000)
  target?: number;

  @IsOptional() @IsString() @MaxLength(6)
  grade?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  specification?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  comment?: string;

  @IsOptional() @IsBoolean()
  onReceipt?: boolean;

  @IsOptional() @IsBoolean()
  onProduction?: boolean;

  @IsOptional() @IsBoolean()
  onRetest?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(100000)
  line?: number;
}

// Update a test requirement — all fields optional; only the supplied ones change.
export class UpdateItemTestDto {
  @IsOptional() @IsString() @MaxLength(20)
  test?: string;

  @IsOptional() @IsString() @MaxLength(20)
  testGroup?: string;

  @IsOptional() @IsString() @MaxLength(40)
  qualifier?: string;

  @IsOptional() @IsNumber() @Min(-1_000_000_000) @Max(1_000_000_000)
  min?: number;

  @IsOptional() @IsNumber() @Min(-1_000_000_000) @Max(1_000_000_000)
  max?: number;

  @IsOptional() @IsNumber() @Min(-1_000_000_000) @Max(1_000_000_000)
  target?: number;

  @IsOptional() @IsString() @MaxLength(6)
  grade?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  specification?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  comment?: string;

  @IsOptional() @IsBoolean()
  onReceipt?: boolean;

  @IsOptional() @IsBoolean()
  onProduction?: boolean;

  @IsOptional() @IsBoolean()
  onRetest?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(100000)
  line?: number;
}
