import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

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
  @IsString()
  @MinLength(6)
  initialPassword!: string;

  @IsOptional()
  @IsString()
  roleCode?: string;
}
