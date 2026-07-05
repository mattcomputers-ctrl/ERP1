import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { CofaController } from './cofa.controller';
import { CofaService } from './cofa.service';
import { ItemTestsController } from './item-tests.controller';
import { ItemTestsService } from './item-tests.service';
import { ReleasesController } from './releases.controller';
import { ReleasesService } from './releases.service';

@Module({
  imports: [AuthModule, SettingsModule, ApprovalModule, NotificationsModule],
  controllers: [CofaController, ReleasesController, ItemTestsController],
  providers: [CofaService, ReleasesService, ItemTestsService],
})
export class QaModule {}
