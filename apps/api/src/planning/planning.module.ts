import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { PlanningRecalcService } from './planning-recalc.service';
import { PlanningController } from './planning.controller';
import { PlanningService } from './planning.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [PlanningController],
  providers: [PlanningService, PlanningRecalcService],
})
export class PlanningModule {}
