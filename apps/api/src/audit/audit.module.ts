import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { ESignatureService } from './esignature.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditService, ESignatureService],
  exports: [AuditService, ESignatureService],
})
export class AuditModule {}
