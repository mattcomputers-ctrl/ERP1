import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GenealogyModule } from '../genealogy/genealogy.module';
import { ImportController } from './import.controller';
import { LegacyDbService } from './legacy-db.service';
import { LegacyImportService } from './legacy-import.service';

@Module({
  imports: [AuthModule, GenealogyModule],
  controllers: [ImportController],
  providers: [LegacyImportService, LegacyDbService],
})
export class ImportModule {}
