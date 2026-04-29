import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Balance } from '../time-off/entities/balance.entity';
import { TimeOffRequest } from '../time-off/entities/time-off-request.entity';
import { RequestLog } from '../time-off/entities/request-log.entity';
import { RequestStatus } from '../time-off/enums/request-status.enum';
import { TimeOffService } from '../time-off/time-off.service';
import { HcmService } from '../hcm/hcm.service';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(RequestLog)
    private readonly requestLogRepo: Repository<RequestLog>,
    private readonly timeOffService: TimeOffService,
    private readonly hcmService: HcmService,
    private readonly dataSource: DataSource,
  ) { }

  @Cron(CronExpression.EVERY_HOUR)
  async handleHourlySync() {
    this.logger.log('Starting hourly sync...');
    let retried = 0;
    let expired = 0;

    try {
      // 1. Retry APPROVED requests
      const stuckRequests = await this.requestRepo.find({
        where: { status: RequestStatus.APPROVED || RequestStatus.SYNC_FAILED },
        relations: ['requestedDates'],
      });

      for (const req of stuckRequests) {
        try {
          await this.timeOffService.syncSingleRequest(req);
          retried++;
        } catch (error) {
          this.logger.error(`Failed to retry request ${req.request_id}`, error);
        }
      }

      // 2. Expire PENDING requests where all dates are in the past
      const pendingRequests = await this.requestRepo.find({
        where: { status: RequestStatus.PENDING },
        relations: ['requestedDates'],
      });

      const todayStr = new Date().toISOString().split('T')[0];

      for (const req of pendingRequests) {
        // "ALL requested dates are in the past"
        const allInPast = req.requestedDates.length > 0 && req.requestedDates.every(rd => rd.date < todayStr);
        if (allInPast) {
          const queryRunner = this.dataSource.createQueryRunner();
          await queryRunner.connect();
          await queryRunner.startTransaction();
          try {
            await queryRunner.manager.update(TimeOffRequest, { request_id: req.request_id }, { status: RequestStatus.EXPIRED });
            const log = this.requestLogRepo.create({
              request_id: req.request_id,
              status: RequestStatus.EXPIRED,
            });
            await queryRunner.manager.save(log);
            await queryRunner.commitTransaction();
            expired++;
          } catch (error) {
            await queryRunner.rollbackTransaction();
            this.logger.error(`Failed to expire request ${req.request_id}`, error);
          } finally {
            await queryRunner.release();
          }
        }
      }
    } catch (error) {
      this.logger.error('Error during hourly sync execution', error);
    }

    this.logger.log(`Hourly sync: ${retried} requests retried, ${expired} requests expired`);
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleDailyReconciliation() {
    this.logger.log('Starting daily reconciliation...');
    let updated = 0;

    try {
      const balances = await this.hcmService.getAllBalances();

      for (const hcmBalance of balances) {
        try {
          const localBalance = await this.balanceRepo.findOne({
            where: { employee_id: String(hcmBalance.employee_id), location_id: String(hcmBalance.location_id) },
          });

          if (localBalance) {
            if (localBalance.balance !== hcmBalance.balance) {
              await this.balanceRepo.update(
                { employee_id: localBalance.employee_id, location_id: localBalance.location_id },
                {
                  balance: hcmBalance.balance,
                  last_synced_at: new Date()
                }
              );
              updated++;
            }
          } else {
            const newBalance = this.balanceRepo.create({
              employee_id: String(hcmBalance.employee_id),
              location_id: String(hcmBalance.location_id),
              balance: hcmBalance.balance,
              last_synced_at: new Date(),
            });
            await this.balanceRepo.save(newBalance);
            updated++;
          }
        } catch (error) {
          this.logger.error(`Failed to reconcile balance for employee ${hcmBalance.employee_id} at location ${hcmBalance.location_id}`, error);
        }
      }
    } catch (error) {
      this.logger.error('Error during daily reconciliation execution', error);
    }

    this.logger.log(`Daily reconciliation: ${updated} balances updated`);
  }
}
