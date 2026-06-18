import { IsIn } from 'class-validator';

export type UserStatusValue = 'ACTIVE' | 'DISABLED' | 'LOCKED' | 'INVITED';

export class SetStatusDto {
  @IsIn(['ACTIVE', 'DISABLED', 'LOCKED', 'INVITED'])
  status!: UserStatusValue;
}
