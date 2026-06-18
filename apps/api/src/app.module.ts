import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { GenealogyModule } from './genealogy/genealogy.module';
import { HealthModule } from './health/health.module';
import { ImportModule } from './import/import.module';
import { InventoryModule } from './inventory/inventory.module';
import { ManufacturingModule } from './manufacturing/manufacturing.module';
import { MasterDataModule } from './master-data/master-data.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AuthModule,
    UsersModule,
    HealthModule,
    MasterDataModule,
    ImportModule,
    InventoryModule,
    ManufacturingModule,
    OrdersModule,
    GenealogyModule,
    SettingsModule,
  ],
})
export class AppModule {}
