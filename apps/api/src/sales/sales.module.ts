import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { ApprovalModule } from '../approval/approval.module';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SettingsModule } from '../settings/settings.module';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PackingSlipController } from './packing-slip.controller';
import { PackingSlipService } from './packing-slip.service';
import { PartyService } from './party.service';
import { SalesPricingController } from './sales-pricing.controller';
import { SalesPricingService } from './sales-pricing.service';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';
import { StagingController } from './staging.controller';
import { StagingService } from './staging.service';

@Module({
  imports: [AuthModule, SettingsModule, ApprovalModule, AccountingModule, InventoryModule],
  controllers: [InvoicesController, PackingSlipController, BillsController, ShippingController, SalesPricingController, StagingController],
  providers: [InvoicesService, PackingSlipService, PartyService, BillsService, ShippingService, SalesPricingService, StagingService],
  exports: [PartyService, SalesPricingService],
})
export class SalesModule {}
