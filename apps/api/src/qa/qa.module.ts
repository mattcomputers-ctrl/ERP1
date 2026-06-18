import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { CofaController } from './cofa.controller';
import { CofaService } from './cofa.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [CofaController],
  providers: [CofaService],
})
export class QaModule {}
