import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

// Replace a user's role (group) membership with the given set of role codes.
export class SetUserRolesDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  roleCodes!: string[];
}
