import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Start TOTP enrollment (sudo step: re-verify the password; when RE-enrolling,
 * the current TOTP code is demanded too so a hijacked session can't swap the
 * authenticator). */
export class MfaEnrollDto {
  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsOptional()
  @IsString()
  totpCode?: string;
}

/** Prove possession of the new secret with a first code. */
export class MfaConfirmDto {
  @IsString()
  @IsNotEmpty()
  code!: string;
}

/** Disable MFA — password plus the current second factor (TOTP or a recovery
 * code when the authenticator is lost). */
export class MfaDisableDto {
  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsOptional()
  @IsString()
  totpCode?: string;

  @IsOptional()
  @IsString()
  recoveryCode?: string;
}
