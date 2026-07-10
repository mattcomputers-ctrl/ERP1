import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandingController } from './branding.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [AuthModule],
  controllers: [SettingsController, BrandingController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
