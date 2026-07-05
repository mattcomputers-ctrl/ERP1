import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { EmailProcessorService } from './email-processor.service';
import { MailTransport } from './mail-transport';
import { NotificationEngineService } from './notification-engine.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationEngineService, EmailProcessorService, MailTransport],
  // The engine is what other modules (orders, purchasing, inventory, QA,
  // planning, master-data) call at their mutation seams.
  exports: [NotificationEngineService],
})
export class NotificationsModule {}
