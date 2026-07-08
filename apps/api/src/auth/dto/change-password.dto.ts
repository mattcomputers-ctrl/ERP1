import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  // The DTO floor matches the service floor (6); the OPERATOR-CONFIGURED
  // minimum (security.passwordMinLength, default 12) is enforced dynamically
  // in AuthService.assertPasswordPolicy — a @MinLength(12) here would
  // silently pre-empt a configured minimum below 12.
  @IsString()
  @MinLength(6)
  newPassword!: string;
}
