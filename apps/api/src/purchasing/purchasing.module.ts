import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SalesModule } from '../sales/sales.module';
import { SettingsModule } from '../settings/settings.module';
import { PriceVersionService } from './price-version.service';
import { PurchasingController } from './purchasing.controller';
import { PurchasingService } from './purchasing.service';
import { SupplierPricingController } from './supplier-pricing.controller';
import { SupplierPricingService } from './supplier-pricing.service';

@Module({
  imports: [AuthModule, SettingsModule, SalesModule, InventoryModule, ApprovalModule, NotificationsModule],
  controllers: [PurchasingController, SupplierPricingController],
  providers: [PurchasingService, PriceVersionService, SupplierPricingService],
  exports: [PurchasingService, PriceVersionService],
})
export class PurchasingModule {}
