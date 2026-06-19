import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ValuationService } from './valuation.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [InventoryController],
  providers: [InventoryService, ValuationService],
  exports: [ValuationService],
})
export class InventoryModule {}
