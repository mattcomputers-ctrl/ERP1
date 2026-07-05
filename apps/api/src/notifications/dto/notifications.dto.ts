import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateNotificationDto {
  @IsString()
  @MaxLength(50)
  notificationCode!: string;

  // Defaults to '*' (the fallback rule) like the legacy editor.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  securityGroup?: string;

  @IsOptional()
  @IsString()
  sendTo?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsBoolean()
  useSendtoListOnly?: boolean;
}

export class UpdateNotificationDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  securityGroup?: string;

  @IsOptional()
  @IsString()
  sendTo?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsBoolean()
  useSendtoListOnly?: boolean;
}

export class CreateNotificationDetailDto {
  @Type(() => Number)
  @IsInt()
  ownerId!: number;

  @IsString()
  sendTo!: string;
}

export class TestEmailDto {
  @IsEmail()
  to!: string;
}
