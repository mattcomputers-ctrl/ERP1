import { IsInt, IsNumber, IsOptional, Min } from 'class-validator';

export class GenerateInvoiceDto {
  @IsInt()
  orderId!: number;

  // Freight charged on this invoice (document currency). Taxed per UG
  // §17.4.7.2 via the 'Freight' item tax group.
  @IsOptional()
  @IsNumber()
  @Min(0)
  freightCharge?: number;
}
