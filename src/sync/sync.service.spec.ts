import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SyncService } from './sync.service';
import { Balance } from '../time-off/entities/balance.entity';
import { TimeOffRequest } from '../time-off/entities/time-off-request.entity';
import { RequestLog } from '../time-off/entities/request-log.entity';
import { TimeOffService } from '../time-off/time-off.service';
import { HcmService } from '../hcm/hcm.service';
import { RequestStatus } from '../time-off/enums/request-status.enum';

const mockQueryRunner = {
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: {
    save: jest.fn(),
    update: jest.fn(),
  },
};

const mockDataSource = {
  createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
};

const mockBalanceRepo = {
  findOne: jest.fn(),
  create: jest.fn().mockImplementation(dto => dto),
  save: jest.fn(),
  update: jest.fn(),
};

const mockRequestRepo = {
  find: jest.fn(),
};

const mockRequestLogRepo = {
  create: jest.fn().mockImplementation(dto => dto),
};

const mockTimeOffService = {
  syncSingleRequest: jest.fn(),
};

const mockHcmService = {
  getAllBalances: jest.fn(),
};

describe('SyncService', () => {
  let service: SyncService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(Balance), useValue: mockBalanceRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRequestRepo },
        { provide: getRepositoryToken(RequestLog), useValue: mockRequestLogRepo },
        { provide: TimeOffService, useValue: mockTimeOffService },
        { provide: HcmService, useValue: mockHcmService },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
    jest.clearAllMocks();
  });

  describe('handleHourlySync', () => {
    it('should retry APPROVED requests and expire past PENDING requests', async () => {
      // Mock APPROVED
      mockRequestRepo.find.mockResolvedValueOnce([{ request_id: '1', status: RequestStatus.APPROVED }]);
      mockTimeOffService.syncSingleRequest.mockResolvedValue('SYNCED');

      // Mock PENDING
      mockRequestRepo.find.mockResolvedValueOnce([
        {
          request_id: '2',
          status: RequestStatus.PENDING,
          requestedDates: [{ date: '2000-01-01' }] // past date
        }
      ]);

      await service.handleHourlySync();

      expect(mockTimeOffService.syncSingleRequest).toHaveBeenCalledTimes(1);
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { request_id: '2' },
        { status: RequestStatus.EXPIRED }
      );
    });
  });

  describe('handleDailyReconciliation', () => {
    it('should fetch from HCM and update local balances', async () => {
      mockHcmService.getAllBalances.mockResolvedValue([
        { employee_id: '1', location_id: '1', balance: 50 }
      ]);
      mockBalanceRepo.findOne.mockResolvedValue({ employee_id: '1', location_id: '1', balance: 10 });

      await service.handleDailyReconciliation();

      expect(mockHcmService.getAllBalances).toHaveBeenCalled();
      expect(mockBalanceRepo.update).toHaveBeenCalledWith(
        { employee_id: '1', location_id: '1' },
        expect.objectContaining({ balance: 50 })
      );
    });
  });
});
