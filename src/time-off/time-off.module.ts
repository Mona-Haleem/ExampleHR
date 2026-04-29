import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from './entities/balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { RequestedDate } from './entities/requested-date.entity';
import { RequestLog } from './entities/request-log.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Balance, TimeOffRequest, RequestedDate, RequestLog]),
  ],
})
export class TimeOffModule {}
