import { IsNotEmpty, IsString, ValidateIf } from 'class-validator';

/**
 * Link (or unlink, with null) a user's OIDC subject. ValidateIf — not
 * IsOptional — so an explicit null passes while a missing field or an empty
 * string is still rejected (@IsOptional would skip ALL validators on null).
 */
export class SetSsoSubjectDto {
  @ValidateIf((o: SetSsoSubjectDto) => o.ssoSubject !== null)
  @IsString()
  @IsNotEmpty()
  ssoSubject!: string | null;
}
