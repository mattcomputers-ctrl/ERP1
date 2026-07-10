import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  displayName!: string;

  @IsOptional()
  @IsString()
  username?: string;

  // Floor only — the operator-configured minimum (security.passwordMinLength)
  // is enforced in the service via AuthService.assertPasswordPolicy.
  // OPTIONAL since SSO: a user created with an ssoSubject and no password is
  // SSO-only (passwordHash stays null; password login is impossible). The
  // service refuses a user with NEITHER a password NOR an SSO subject.
  @IsOptional()
  @IsString()
  @MinLength(6)
  initialPassword?: string;

  /** OIDC subject claim for SSO login (pre-provisioned linking — no JIT). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ssoSubject?: string;

  @IsOptional()
  @IsString()
  roleCode?: string;
}
