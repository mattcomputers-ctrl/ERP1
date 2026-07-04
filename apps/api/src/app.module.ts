import { Module } from '@nestjs/common';
import { AccountingModule } from './accounting/accounting.module';
import { ApprovalModule } from './approval/approval.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { GenealogyModule } from './genealogy/genealogy.module';
import { HealthModule } from './health/health.module';
import { ImportModule } from './import/import.module';
import { InventoryModule } from './inventory/inventory.module';
import { LotTrackingModule } from './lot-tracking/lot-tracking.module';
import { ManufacturingModule } from './manufacturing/manufacturing.module';
import { MasterDataModule } from './master-data/master-data.module';
import { OrdersModule } from './orders/orders.module';
import { PlanningModule } from './planning/planning.module';
import { PrismaModule } from './prisma/prisma.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { RolesModule } from './roles/roles.module';
import { SecuredItemsModule } from './secured-items/secured-items.module';
import { QaModule } from './qa/qa.module';
import { SalesModule } from './sales/sales.module';
import { SettingsModule } from './settings/settings.module';
import { StatsModule } from './stats/stats.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AuthModule,
    UsersModule,
    RolesModule,
    SecuredItemsModule,
    ApprovalModule,
    HealthModule,
    MasterDataModule,
    ImportModule,
    InventoryModule,
    LotTrackingModule,
    ManufacturingModule,
    OrdersModule,
    PlanningModule,
    PurchasingModule,
    GenealogyModule,
    SettingsModule,
    StatsModule,
    SalesModule,
    QaModule,
    AccountingModule,
  ],
})
export class AppModule {}
