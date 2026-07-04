import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional } from 'class-validator';

export class CreatePoFromPlanDto {
  /** Selected Plan Tracing line ids (Short/Negative rows, one item+manufacturer). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  planTraceIds!: number[];

  /** Chosen supplier when more than one prices the combination (the vendor's
   * "which pricing" prompt round-trips through needsSupplierChoice). */
  @IsOptional()
  @IsInt()
  supplierId?: number;
}
