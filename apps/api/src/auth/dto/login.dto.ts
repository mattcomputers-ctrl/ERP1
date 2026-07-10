import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  /** TOTP code — required (via a 401 MFA_REQUIRED round-trip) when enrolled. */
  @IsOptional()
  @IsString()
  totpCode?: string;

  /** Single-use recovery code — the fallback when the authenticator is lost. */
  @IsOptional()
  @IsString()
  recoveryCode?: string;
}
