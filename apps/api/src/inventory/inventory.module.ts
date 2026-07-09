import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { MiscReceiptController } from './misc-receipt.controller';
import { MiscReceiptService } from './misc-receipt.service';
import { MovementRecorderService } from './movement-recorder.service';
import { ValuationService } from './valuation.service';

@Module({
  imports: [AuthModule, SettingsModule, NotificationsModule],
  controllers: [InventoryController, MiscReceiptController],
  providers: [InventoryService, ValuationService, MiscReceiptService, MovementRecorderService],
  exports: [ValuationService, MovementRecorderService],
})
export class InventoryModule {}
