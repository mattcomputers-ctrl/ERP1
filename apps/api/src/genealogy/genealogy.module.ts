import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SalesModule } from '../sales/sales.module';
import { GenealogyController } from './genealogy.controller';
import { GenealogyService } from './genealogy.service';

@Module({
  imports: [AuthModule, SalesModule],
  controllers: [GenealogyController],
  providers: [GenealogyService],
  exports: [GenealogyService],
})
export class GenealogyModule {}
