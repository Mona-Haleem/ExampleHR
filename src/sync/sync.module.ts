import { Module } from '@nestjs/common';
import { TimeOffModule } from '../time-off/time-off.module';
import { HcmModule } from '../hcm/hcm.module';
import { SyncService } from './sync.service';

@Module({
  imports: [TimeOffModule, HcmModule],
  providers: [SyncService],
})
export class SyncModule { }
