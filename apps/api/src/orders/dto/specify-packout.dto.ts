import { IsInt, IsISO8601, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from 'class-validator';

/** UG §6.4 New Requirements row: make a packout from a batch order's bulk. */
export class SpecifyPackoutDto {
  /** The ItemPackagedProduct binding (packout option) to order (int4 id). */
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  itemPackagedProductId!: number;

  /**
   * Units of the packaged product to make — the packaging order's batch size
   * (RMPP recipes are normalised per unit, like every recipe).
   */
  @IsNumber()
  @IsPositive()
  @Max(100_000_000)
  makeQty!: number;

  /**
   * Bulk quantity allocated from THIS batch (vendor's editable Supplied Qty —
   * less than the full requirement when the packaging run spans batches).
   * Defaults to the full bulk requirement; may not exceed it.
   */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  suppliedQty?: number;

  /** Optional required/due date for the packaging order (ISO 8601). */
  @IsOptional()
  @IsISO8601()
  dateRequired?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  reference?: string;
}
