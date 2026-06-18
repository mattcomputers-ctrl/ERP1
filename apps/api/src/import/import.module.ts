import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportController } from './import.controller';
import { LegacyImportService } from './legacy-import.service';

@Module({
  imports: [AuthModule],
  controllers: [ImportController],
  providers: [LegacyImportService],
})
export class ImportModule {}
