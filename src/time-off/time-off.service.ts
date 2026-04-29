import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Balance } from './entities/balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { RequestedDate } from './entities/requested-date.entity';
import { RequestLog } from './entities/request-log.entity';
import { RequestStatus } from './enums/request-status.enum';
import { HcmService } from '../hcm/hcm.service';

@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(RequestedDate)
    private readonly requestedDateRepo: Repository<RequestedDate>,
    @InjectRepository(RequestLog)
    private readonly requestLogRepo: Repository<RequestLog>,
    private readonly hcmService: HcmService,
    private readonly dataSource: DataSource,
  ) { }

  async getBalance(employeeId: string, locationId: string) {
    const balanceRecord = await this.balanceRepo.findOne({
      where: { employee_id: employeeId, location_id: locationId },
    });

    if (!balanceRecord) {
      throw new NotFoundException(`Balance not found for employee ${employeeId} at location ${locationId}`);
    }

    const { sum } = await this.requestRepo
      .createQueryBuilder('req')
      .select('SUM(req.days_count)', 'sum')
      .where('req.employee_id = :employeeId', { employeeId })
      .andWhere('req.location_id = :locationId', { locationId })
      .andWhere('req.status IN (:...statuses)', { statuses: [RequestStatus.PENDING, RequestStatus.APPROVED] })
      .getRawOne();

    const reservedBalance = parseInt(sum || '0', 10);
    const availableBalance = balanceRecord.balance - reservedBalance;

    return {
      employee_id: employeeId,
      location_id: locationId,
      balance: balanceRecord.balance,
      availableBalance,
      reservedBalance,
      last_synced_at: balanceRecord.last_synced_at,
    };
  }

  async submitRequest(employeeId: string, locationId: string, datesList: string[]) {
    if (!datesList || datesList.length === 0) {
      throw new BadRequestException('Dates list cannot be empty');
    }

    const todayStr = new Date().toISOString().split('T')[0];
    if (datesList.some(date => date < todayStr)) {
      throw new BadRequestException('Dates cannot be in the past');
    }

    const existingRequests = await this.requestRepo.find({
      where: {
        employee_id: employeeId,
        location_id: locationId,
        status: In([RequestStatus.PENDING, RequestStatus.APPROVED]),
      },
      relations: ['requestedDates'],
    });

    const existingDates = new Set(
      existingRequests.flatMap(req => req.requestedDates.map(rd => rd.date))
    );

    if (datesList.some(date => existingDates.has(date))) {
      throw new ConflictException('Date overlap with existing PENDING or APPROVED request');
    }

    const { availableBalance } = await this.getBalance(employeeId, locationId);

    if (availableBalance < datesList.length) {
      throw new UnprocessableEntityException('Insufficient available balance');
    }

    const requestId = uuidv4();
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const timeOffRequest = this.requestRepo.create({
        request_id: requestId,
        employee_id: employeeId,
        location_id: locationId,
        status: RequestStatus.PENDING,
      });
      await queryRunner.manager.save(timeOffRequest);

      const requestedDates = datesList.map(date =>
        this.requestedDateRepo.create({
          request_id: requestId,
          date: date,
        })
      );
      await queryRunner.manager.save(requestedDates);

      const requestLog = this.requestLogRepo.create({
        request_id: requestId,
        status: RequestStatus.PENDING,
      });
      await queryRunner.manager.save(requestLog);

      await queryRunner.commitTransaction();

      const newBalanceInfo = await this.getBalance(employeeId, locationId);

      return {
        request_id: requestId,
        status: RequestStatus.PENDING,
        remainingBalance: newBalanceInfo.availableBalance,
        reservedBalance: newBalanceInfo.reservedBalance,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async getRequest(requestId: string) {
    const request = await this.requestRepo.findOne({
      where: { request_id: requestId },
      relations: ['requestedDates'],
    });

    if (!request) {
      throw new NotFoundException(`Request ${requestId} not found`);
    }

    return request;
  }

  async getAllRequests(filters: { status?: RequestStatus, employeeId?: string, locationId?: string } = {}) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.employeeId) where.employee_id = filters.employeeId;
    if (filters.locationId) where.location_id = filters.locationId;

    return this.requestRepo.find({
      where,
      relations: ['requestedDates'],
    });
  }

  async approveRequest(requestId: string) {
    const request = await this.getRequest(requestId);

    if (request.status !== RequestStatus.PENDING) {
      throw new ConflictException('Request must be in PENDING status to approve');
    }

    await this.updateStatus(requestId, RequestStatus.APPROVED);

    const updatedRequest = await this.getRequest(requestId);
    const syncStatus = await this.syncSingleRequest(updatedRequest);

    return {
      request_id: requestId,
      status: RequestStatus.APPROVED,
      hcmSyncStatus: syncStatus,
    };
  }

  async rejectRequest(requestId: string) {
    const request = await this.getRequest(requestId);

    if (request.status !== RequestStatus.PENDING) {
      throw new ConflictException('Request must be in PENDING status to reject');
    }

    await this.updateStatus(requestId, RequestStatus.REJECTED);

    const balanceInfo = await this.getBalance(request.employee_id, request.location_id);
    return {
      request_id: requestId,
      status: RequestStatus.REJECTED,
      remainingBalance: balanceInfo.availableBalance,
      reservedBalance: balanceInfo.reservedBalance,
    };
  }

  async cancelRequest(requestId: string) {
    const request = await this.getRequest(requestId);

    if (request.status !== RequestStatus.PENDING) {
      throw new ConflictException('Request must be in PENDING status to cancel');
    }

    await this.updateStatus(requestId, RequestStatus.CANCELLED);

    const balanceInfo = await this.getBalance(request.employee_id, request.location_id);
    return {
      request_id: requestId,
      status: RequestStatus.CANCELLED,
      remainingBalance: balanceInfo.availableBalance,
      reservedBalance: balanceInfo.reservedBalance,
    };
  }

  async syncSingleRequest(request: TimeOffRequest): Promise<string> {
    const balanceInfo = await this.getBalance(request.employee_id, request.location_id);
    if (balanceInfo.availableBalance < 0) {
      await this.updateStatus(request.request_id, RequestStatus.SYNC_FAILED);
      return 'SYNC_FAILED';
    }

    const dates = request.requestedDates.map(rd => rd.date);
    let attempts = 0;

    while (attempts < 3) {
      attempts++;
      try {
        const result = await this.hcmService.submitTimeOff(request.employee_id, request.location_id, dates);

        if (result.new_balance < 0) {
          this.logger.warn(`HCM returned negative balance ${result.new_balance} for request ${request.request_id}`);
          await this.updateStatus(request.request_id, RequestStatus.SYNC_FAILED);
          return 'SYNC_FAILED';
        }

        const balanceRecord = await this.balanceRepo.findOneBy({ employee_id: request.employee_id, location_id: request.location_id });
        if (balanceRecord) {
          const updateResult = await this.balanceRepo.update(
            { employee_id: request.employee_id, location_id: request.location_id },
            { balance: result.new_balance, last_synced_at: new Date() }
          );

          if (updateResult.affected === 0) {
            this.logger.error(`Optimistic lock failure for balance update, employee ${request.employee_id}`);
            return 'PENDING_RETRY';
          }
        }

        await this.updateStatus(request.request_id, RequestStatus.SYNCED);
        return 'SYNCED';

      } catch (error: any) {
        if (error.status === 422 || error.status === 404 || error.status === 409) {
          // Validation error
          await this.updateStatus(request.request_id, RequestStatus.SYNC_FAILED);
          try {
            const freshBalance = await this.hcmService.getBalance(request.location_id, request.employee_id);
            await this.updateBalanceCache(request.employee_id, request.location_id, freshBalance.balance);
          } catch (e) {
            this.logger.error('Failed to fetch fresh balance after validation error', e);
          }
          return 'SYNC_FAILED';
        }

        if (attempts >= 3) {
          return 'PENDING_RETRY';
        }

        // Wait 10 seconds before retry
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    return 'PENDING_RETRY';
  }

  private async updateBalanceCache(employeeId: string, locationId: string, newBalance: number) {
    const record = await this.balanceRepo.findOneBy({ employee_id: employeeId, location_id: locationId });
    if (record) {
      await this.balanceRepo.update(
        { employee_id: employeeId, location_id: locationId },
        { balance: newBalance, last_synced_at: new Date() }
      );
    }
  }

  private async updateStatus(requestId: string, newStatus: RequestStatus) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.manager.update(TimeOffRequest, { request_id: requestId }, { status: newStatus });
      const log = this.requestLogRepo.create({
        request_id: requestId,
        status: newStatus,
      });
      await queryRunner.manager.save(log);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
