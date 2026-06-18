import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  displayName!: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsString()
  @MinLength(12)
  initialPassword!: string;

  @IsOptional()
  @IsString()
  roleCode?: string;
}
