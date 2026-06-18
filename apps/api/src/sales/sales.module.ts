import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PackingSlipController } from './packing-slip.controller';
import { PackingSlipService } from './packing-slip.service';
import { PartyService } from './party.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [InvoicesController, PackingSlipController],
  providers: [InvoicesService, PackingSlipService, PartyService],
})
export class SalesModule {}
