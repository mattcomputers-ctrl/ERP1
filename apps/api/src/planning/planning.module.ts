import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { SettingsModule } from '../settings/settings.module';
import { PlanningPoService } from './planning-po.service';
import { PlanningRecalcService } from './planning-recalc.service';
import { PlanningController } from './planning.controller';
import { PlanningService } from './planning.service';

@Module({
  imports: [AuthModule, SettingsModule, PurchasingModule],
  controllers: [PlanningController],
  providers: [PlanningService, PlanningRecalcService, PlanningPoService],
})
export class PlanningModule {}
