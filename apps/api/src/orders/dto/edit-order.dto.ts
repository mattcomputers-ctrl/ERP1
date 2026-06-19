import { IsISO8601, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from 'class-validator';

/**
 * Edit a not-yet-released order. A new batchSize rescales every line that carries
 * a per-unit base (StdQty); header fields update in place. All fields optional.
 */
export class EditOrderDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(100_000_000)
  batchSize?: number;

  @IsOptional()
  @IsISO8601()
  dateRequired?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
