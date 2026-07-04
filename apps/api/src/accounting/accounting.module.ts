import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { AccountingController } from './accounting.controller';
import { AccountingExportService } from './export.service';
import { GlMastersService } from './gl-masters.service';
import { AccountingJournalService } from './journal.service';
import { TaxService } from './tax.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [AccountingController],
  providers: [GlMastersService, TaxService, AccountingJournalService, AccountingExportService],
  exports: [TaxService],
})
export class AccountingModule {}
