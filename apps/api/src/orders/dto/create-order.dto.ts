import { IsInt, IsISO8601, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from 'class-validator';

export class CreateOrderDto {
  /** RMBA (batching) recipe to scale into the order's lines. */
  @IsInt()
  recipeId!: number;

  /**
   * Total batch size, in the recipe's weight unit. Recipe formulas are
   * normalised per unit batch, so every ingredient/product quantity is scaled by
   * this value (OrdDetail.QtyReqd = RecipeDetail.QtyReqd × batchSize). Bounded
   * above to reject fat-finger / overflow input; the service also re-checks.
   */
  @IsNumber()
  @IsPositive()
  @Max(100_000_000)
  batchSize!: number;

  /** Optional required/due date (ISO 8601; the UI sends yyyy-mm-dd). */
  @IsOptional()
  @IsISO8601()
  dateRequired?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  reference?: string;
}
