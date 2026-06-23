import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateRoleDto {
  /** Stable role code (the unique key, e.g. QA_MANAGER). */
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}

export class SetRoleProgramsDto {
  /** The complete set of program keys the role should be granted (replaces the
   * current set). */
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  programKeys!: string[];
}
