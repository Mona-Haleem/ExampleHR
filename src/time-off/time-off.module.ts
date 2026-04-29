import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from './entities/balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { RequestedDate } from './entities/requested-date.entity';
import { RequestLog } from './entities/request-log.entity';
import { TimeOffService } from './time-off.service';
import { TimeOffController } from './time-off.controller';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Balance, TimeOffRequest, RequestedDate, RequestLog]),
    HcmModule,
  ],
  controllers: [TimeOffController],
  providers: [TimeOffService],
  exports: [TimeOffService, TypeOrmModule],
})
export class TimeOffModule {}
