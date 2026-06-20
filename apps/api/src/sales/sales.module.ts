import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PackingSlipController } from './packing-slip.controller';
import { PackingSlipService } from './packing-slip.service';
import { PartyService } from './party.service';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [InvoicesController, PackingSlipController, BillsController, ShippingController],
  providers: [InvoicesService, PackingSlipService, PartyService, BillsService, ShippingService],
  exports: [PartyService],
})
export class SalesModule {}
