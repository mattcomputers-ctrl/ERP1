import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ViewersController } from './viewers.controller';
import { ViewersService } from './viewers.service';

@Module({
  imports: [AuthModule],
  controllers: [ViewersController],
  providers: [ViewersService],
})
export class ViewersModule {}
