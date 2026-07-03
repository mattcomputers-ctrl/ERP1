import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class IptResultDto {
  /** The order's OrdDetailTest row to record against. */
  @IsInt()
  testId!: number;

  /** The observed result (blank/omitted clears a previously recorded one). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  result?: string;
}

/** Record in-process test results during batch execution. */
export class IptResultsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => IptResultDto)
  results!: IptResultDto[];
}
