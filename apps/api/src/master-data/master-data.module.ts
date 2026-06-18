import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitiesController } from './entities/entities.controller';
import { EntitiesService } from './entities/entities.service';
import { ItemsController } from './items/items.controller';
import { ItemsService } from './items/items.service';
import { UnitsController } from './units/units.controller';
import { UnitsService } from './units/units.service';

@Module({
  imports: [AuthModule],
  controllers: [EntitiesController, ItemsController, UnitsController],
  providers: [EntitiesService, ItemsService, UnitsService],
})
export class MasterDataModule {}
