import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
// SamplingService is QA-domain code (lives in qa/) but is PROVIDED here: it
// depends on MovementRecorderService and is consumed by every sublot-minting
// seam (misc receipt in this module, purchasing, orders, lot-tracking — all of
// which already import InventoryModule). Registering it in QaModule would make
// QaModule↔InventoryModule circular.
import { SamplingService } from '../qa/sampling.service';
import { SettingsModule } from '../settings/settings.module';
import { InventoryController } from './inventory.controller';
import { InventoryCountController } from './inventory-count.controller';
import { InventoryCountService } from './inventory-count.service';
import { InventoryService } from './inventory.service';
import { MiscReceiptController } from './misc-receipt.controller';
import { MiscReceiptService } from './misc-receipt.service';
import { MovementRecorderService } from './movement-recorder.service';
import { ValuationService } from './valuation.service';

@Module({
  imports: [AuthModule, SettingsModule, NotificationsModule],
  controllers: [InventoryController, MiscReceiptController, InventoryCountController],
  providers: [InventoryService, ValuationService, MiscReceiptService, MovementRecorderService, SamplingService, InventoryCountService],
  exports: [ValuationService, MovementRecorderService, SamplingService],
})
export class InventoryModule {}
