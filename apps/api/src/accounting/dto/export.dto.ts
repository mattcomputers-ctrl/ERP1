import { IsArray, IsIn, IsOptional, IsString, Matches } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ExportAccountingDto {
  @IsString()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @IsString()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  /** Subset of: invoices, receipts, miscReceipts, adjustments, builds. Empty/omitted = all. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  kinds?: string[];

  @IsOptional()
  @IsIn(['iif', 'csv'])
  format?: 'iif' | 'csv';
}
