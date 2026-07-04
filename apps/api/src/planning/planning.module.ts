import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlanningController } from './planning.controller';
import { PlanningService } from './planning.service';

@Module({
  imports: [AuthModule],
  controllers: [PlanningController],
  providers: [PlanningService],
})
export class PlanningModule {}
