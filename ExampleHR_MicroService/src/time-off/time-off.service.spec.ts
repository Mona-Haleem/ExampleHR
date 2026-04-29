import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TimeOffService } from './time-off.service';
import { Balance } from './entities/balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { RequestedDate } from './entities/requested-date.entity';
import { RequestLog } from './entities/request-log.entity';
import { HcmService } from '../hcm/hcm.service';
import { RequestStatus } from './enums/request-status.enum';
import { NotFoundException, BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';

const mockQueryRunner = {
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: {
    save: jest.fn(),
    update: jest.fn(),
    findOne: jest.fn(),
  },
};

const mockDataSource = {
  createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
};

const mockBalanceRepo = {
  findOne: jest.fn(),
  findOneBy: jest.fn(),
  update: jest.fn(),
};

const mockRequestRepo = {
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn().mockImplementation(dto => dto),
  createQueryBuilder: jest.fn().mockReturnValue({
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
  }),
};

const mockRequestedDateRepo = {
  create: jest.fn().mockImplementation(dto => dto),
};

const mockRequestLogRepo = {
  create: jest.fn().mockImplementation(dto => dto),
};

const mockHcmService = {
  submitTimeOff: jest.fn(),
  getBalance: jest.fn(),
};

describe('TimeOffService', () => {
  let service: TimeOffService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(Balance), useValue: mockBalanceRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRequestRepo },
        { provide: getRepositoryToken(RequestedDate), useValue: mockRequestedDateRepo },
        { provide: getRepositoryToken(RequestLog), useValue: mockRequestLogRepo },
        { provide: HcmService, useValue: mockHcmService },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<TimeOffService>(TimeOffService);
    jest.clearAllMocks();
  });

  describe('getBalance', () => {
    it('returns balance with computed availableBalance', async () => {
      mockBalanceRepo.findOne.mockResolvedValue({ balance: 20 });
      mockRequestRepo.find.mockResolvedValue([{ requestedDates: [{ date: '2099-01-01' }, { date: '2099-01-02' }, { date: '2099-01-03' }] }]);
      const result = await service.getBalance('1', '1');
      expect(result.balance).toBe(20);
      expect(result.availableBalance).toBe(17);
      expect(result.reservedBalance).toBe(3);
    });

    it('throws NotFoundException for invalid IDs', async () => {
      mockBalanceRepo.findOne.mockResolvedValue(null);
      await expect(service.getBalance('invalid', 'invalid')).rejects.toThrow(NotFoundException);
    });
  });

  describe('submitRequest', () => {
    beforeEach(() => {
      mockBalanceRepo.findOne.mockResolvedValue({ balance: 20 });
    });

    it('creates request with PENDING status and returns remainingBalance', async () => {
      mockRequestRepo.find
        .mockResolvedValueOnce([]) // 1. Overlap check
        .mockResolvedValueOnce([]) // 2. getBalance validation (reserved = 0)
        .mockResolvedValueOnce([{ requestedDates: [{ date: '2099-01-01' }, { date: '2099-01-02' }] }]); // 3. getBalance return (reserved = 2)

      const dates = ['2099-01-01', '2099-01-02'];
      const result = await service.submitRequest('1', '1', dates);
      expect(result.status).toBe(RequestStatus.PENDING);
      expect(result.reservedBalance).toBe(2);
      expect(result.availableBalance).toBe(18); // 20 - 2
      expect(mockQueryRunner.manager.save).toHaveBeenCalled();
    });

    it('throws BadRequestException for empty dates', async () => {
      await expect(service.submitRequest('1', '1', [])).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for past dates', async () => {
      await expect(service.submitRequest('1', '1', ['2000-01-01'])).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException for overlapping dates', async () => {
      mockRequestRepo.find.mockResolvedValue([{ requestedDates: [{ date: '2099-01-01' }] }]);
      await expect(service.submitRequest('1', '1', ['2099-01-01'])).rejects.toThrow(ConflictException);
    });

    it('throws UnprocessableEntityException for insufficient balance', async () => {
      mockRequestRepo.find.mockResolvedValue([]);
      const dates = Array(21).fill('2099-01-01');
      await expect(service.submitRequest('1', '1', dates)).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('getRequest & getAllRequests', () => {
    it('returns request with dates', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ request_id: '1' });
      const result = await service.getRequest('1');
      expect(result).toBeDefined();
    });

    it('throws NotFoundException for invalid request ID', async () => {
      mockRequestRepo.findOne.mockResolvedValue(null);
      await expect(service.getRequest('1')).rejects.toThrow(NotFoundException);
    });

    it('returns all requests without filters', async () => {
      mockRequestRepo.find.mockResolvedValue([{ request_id: '1' }]);
      const result = await service.getAllRequests();
      expect(result).toHaveLength(1);
    });

    it('returns filtered requests', async () => {
      mockRequestRepo.find.mockResolvedValue([{ request_id: '1' }]);
      await service.getAllRequests({ status: RequestStatus.PENDING });
      expect(mockRequestRepo.find).toHaveBeenCalledWith(expect.objectContaining({ where: { status: RequestStatus.PENDING } }));
    });
  });

  describe('Status Transitions', () => {
    beforeEach(() => {
      mockBalanceRepo.findOne.mockResolvedValue({ balance: 20 });
      mockRequestRepo.createQueryBuilder().getRawOne.mockResolvedValue({ sum: '5' });
    });

    it('approves PENDING request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ request_id: '1', status: RequestStatus.PENDING, employee_id: '1', location_id: '1', requestedDates: [] });
      jest.spyOn(service, 'syncSingleRequest').mockResolvedValue('SYNCED');

      const result = await service.approveRequest('1');
      expect(result.status).toBe(RequestStatus.APPROVED);
      expect(service.syncSingleRequest).toHaveBeenCalled();
    });

    it('throws ConflictException when approving non-PENDING request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ request_id: '1', status: RequestStatus.SYNCED });
      await expect(service.approveRequest('1')).rejects.toThrow(ConflictException);
    });

    it('rejects PENDING request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ request_id: '1', status: RequestStatus.PENDING, employee_id: '1', location_id: '1' });
      const result = await service.rejectRequest('1');
      expect(result.status).toBe(RequestStatus.REJECTED);
    });

    it('cancels PENDING request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ request_id: '1', status: RequestStatus.PENDING, employee_id: '1', location_id: '1' });
      const result = await service.cancelRequest('1');
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('throws ConflictException when cancelling APPROVED request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ request_id: '1', status: RequestStatus.APPROVED });
      await expect(service.cancelRequest('1')).rejects.toThrow(ConflictException);
    });
  });

  describe('syncSingleRequest', () => {
    const mockRequest = { request_id: '1', employee_id: '1', location_id: '1', status: RequestStatus.APPROVED, requestedDates: [] } as any;

    beforeEach(() => {
      mockBalanceRepo.findOne.mockResolvedValue({ balance: 20 });
      mockRequestRepo.find.mockResolvedValue([]);
      jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
        if (typeof cb === 'function') cb();
        return {} as any;
      });
    });

    it('returns SYNCED on success', async () => {
      mockHcmService.submitTimeOff.mockResolvedValue({ new_balance: 10 });
      mockBalanceRepo.findOneBy.mockResolvedValue({ balance: 20 });
      mockBalanceRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.syncSingleRequest(mockRequest);
      expect(result).toBe('SYNCED');
    });

    it('returns REJECTED and updates local cache on 422', async () => {
      mockHcmService.submitTimeOff.mockRejectedValue({ status: 422 });
      mockHcmService.getBalance.mockResolvedValue({ balance: 10 });
      mockBalanceRepo.findOneBy.mockResolvedValue({ balance: 20 });

      const result = await service.syncSingleRequest(mockRequest);
      expect(result).toBe('REJECTED');
      expect(mockHcmService.getBalance).toHaveBeenCalled();
      expect(mockBalanceRepo.update).toHaveBeenCalled();
    });

    it('returns SYNC_FAILED on 500 three times', async () => {
      mockHcmService.submitTimeOff.mockRejectedValue({ status: 500 });
      const result = await service.syncSingleRequest(mockRequest);
      expect(result).toBe('SYNC_FAILED');
      expect(mockHcmService.submitTimeOff).toHaveBeenCalledTimes(3);
    });

    it('returns REJECTED on success but negative balance', async () => {
      mockHcmService.submitTimeOff.mockResolvedValue({ new_balance: -5 });
      const result = await service.syncSingleRequest(mockRequest);
      expect(result).toBe('REJECTED');
    });
  });
});
