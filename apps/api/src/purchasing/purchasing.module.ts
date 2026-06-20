import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesModule } from '../sales/sales.module';
import { SettingsModule } from '../settings/settings.module';
import { PriceVersionService } from './price-version.service';
import { PurchasingController } from './purchasing.controller';
import { PurchasingService } from './purchasing.service';

@Module({
  imports: [AuthModule, SettingsModule, SalesModule, InventoryModule],
  controllers: [PurchasingController],
  providers: [PurchasingService, PriceVersionService],
})
export class PurchasingModule {}
