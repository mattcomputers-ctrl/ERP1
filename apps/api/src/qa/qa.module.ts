import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { CofaController } from './cofa.controller';
import { CofaService } from './cofa.service';
import { ReleasesController } from './releases.controller';
import { ReleasesService } from './releases.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [CofaController, ReleasesController],
  providers: [CofaService, ReleasesService],
})
export class QaModule {}
