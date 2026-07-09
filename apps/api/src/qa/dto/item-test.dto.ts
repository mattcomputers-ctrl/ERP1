import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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

// Create a Test-catalog master row (legacy `Test`, natural-key PK = the name).
// Live census: 35 rows, every one carries a TestGroup; result type NUM|BOOL;
// precision only on NUM rows. Prototype/method/spec are 0-use but kept editable.
export class CreateCatalogTestDto {
  @IsString()
  @MaxLength(20)
  test!: string;

  @IsOptional() @IsString() @MaxLength(256)
  description?: string;

  @IsIn(['NUM', 'BOOL'])
  testResultType!: string;

  @IsOptional() @IsInt() @Min(0) @Max(10)
  precision?: number;

  @IsString()
  @MaxLength(20)
  testGroup!: string;

  @IsOptional() @IsString() @MaxLength(20)
  unit?: string;

  @IsOptional() @IsBoolean()
  prototype?: boolean;
}

// Update a Test-catalog row — the NAME is the primary key other tables reference
// (ItemTest/OrdDetailTest/LocationSampleTest link by name, no FK), so it cannot
// be renamed; all other fields optional, only the supplied ones change.
// (@IsOptional skips validators on explicit null — the service re-asserts.)
export class UpdateCatalogTestDto {
  @IsOptional() @IsString() @MaxLength(256)
  description?: string;

  @IsOptional() @IsIn(['NUM', 'BOOL'])
  testResultType?: string;

  @IsOptional() @IsInt() @Min(0) @Max(10)
  precision?: number;

  @IsOptional() @IsString() @MaxLength(20)
  testGroup?: string;

  @IsOptional() @IsString() @MaxLength(20)
  unit?: string;

  @IsOptional() @IsBoolean()
  prototype?: boolean;
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
