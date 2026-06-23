import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesModule } from '../sales/sales.module';
import { SettingsModule } from '../settings/settings.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [AuthModule, SettingsModule, SalesModule, InventoryModule, ApprovalModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
