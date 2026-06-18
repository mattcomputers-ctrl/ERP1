import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitiesController } from './entities/entities.controller';
import { EntitiesService } from './entities/entities.service';
import { ItemsController } from './items/items.controller';
import { ItemsService } from './items/items.service';

@Module({
  imports: [AuthModule],
  controllers: [EntitiesController, ItemsController],
  providers: [EntitiesService, ItemsService],
})
export class MasterDataModule {}
