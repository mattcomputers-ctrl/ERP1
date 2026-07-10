import { IsString, MinLength } from 'class-validator';

/** Admin-set (or reset) password for an existing user — the recovery path for
 * SSO-only accounts that need to e-sign (signatures require a password). */
export class SetPasswordDto {
  // Floor only — the operator-configured minimum (security.passwordMinLength)
  // is enforced in the service via AuthService.assertPasswordPolicy.
  @IsString()
  @MinLength(6)
  password!: string;
}
