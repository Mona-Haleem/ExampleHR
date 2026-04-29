import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HcmService } from './hcm.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        baseURL: configService.get<string>('HCM_BASE_URL'),
        timeout: 10000,
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [HcmService],
  exports: [HcmService],
})
export class HcmModule { }
