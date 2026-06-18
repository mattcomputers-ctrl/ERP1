import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CloseOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
