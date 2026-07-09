import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { LotTrackingController } from './lot-tracking.controller';
import { LotTrackingService } from './lot-tracking.service';

@Module({
  imports: [AuthModule, InventoryModule],
  controllers: [LotTrackingController],
  providers: [LotTrackingService],
})
export class LotTrackingModule {}
