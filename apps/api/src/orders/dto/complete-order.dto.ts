import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class CompleteOrderDto {
  @IsOptional()
  @IsNumber()
  actualBatchSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
