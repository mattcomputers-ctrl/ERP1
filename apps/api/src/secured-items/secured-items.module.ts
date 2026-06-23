import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SecuredItemsController } from './secured-items.controller';
import { SecuredItemsService } from './secured-items.service';

@Module({
  imports: [AuthModule],
  controllers: [SecuredItemsController],
  providers: [SecuredItemsService],
})
export class SecuredItemsModule {}
