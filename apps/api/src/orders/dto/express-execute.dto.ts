import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Express execution: record every remaining procedure line at standard. */
export class ExpressExecuteDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
