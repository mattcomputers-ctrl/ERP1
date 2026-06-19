import { IsArray } from 'class-validator';

/**
 * Enter/update recorded LIMS test results for a release's sample set. Each item
 * targets an existing LocationSampleTest row (by id, validated to belong to the
 * release's sample set); `result` is free text (legacy Result is a sql_variant).
 * Pass/fail is computed server-side against the product's spec.
 */
export class EnterResultsDto {
  @IsArray()
  results!: { id: number; result?: string | null }[];
}
