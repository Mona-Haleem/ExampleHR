import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Balance } from '../../src/time-off/entities/balance.entity';
import { HcmService } from '../../src/hcm/hcm.service';
import { RequestedDate } from '../../src/time-off/entities/requested-date.entity';
import { RequestLog } from '../../src/time-off/entities/request-log.entity';
import { RequestStatus } from '../../src/time-off/enums/request-status.enum';
import { TimeOffRequest } from '../../src/time-off/entities/time-off-request.entity';
import { SyncService } from '../../src/sync/sync.service';
import { TimeOffService } from '../../src/time-off/time-off.service';
import { Repository } from 'typeorm';

describe('TimeOff Integration Tests', () => {
  let service: TimeOffService;
  let syncService: SyncService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;
  let dateRepo: Repository<RequestedDate>;
  let logRepo: Repository<RequestLog>;
  let hcmService: HcmService;

  const mockHcmService = {
    submitTimeOff: jest.fn(),
    getBalance: jest.fn(),
    getAllBalances: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [Balance, TimeOffRequest, RequestedDate, RequestLog],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([Balance, TimeOffRequest, RequestedDate, RequestLog]),
      ],
      providers: [
        TimeOffService,
        SyncService,
        { provide: HcmService, useValue: mockHcmService },
      ],
    }).compile();

    service = module.get<TimeOffService>(TimeOffService);
    syncService = module.get<SyncService>(SyncService);
    balanceRepo = module.get<Repository<Balance>>(getRepositoryToken(Balance));
    requestRepo = module.get<Repository<TimeOffRequest>>(getRepositoryToken(TimeOffRequest));
    dateRepo = module.get<Repository<RequestedDate>>(getRepositoryToken(RequestedDate));
    logRepo = module.get<Repository<RequestLog>>(getRepositoryToken(RequestLog));
    hcmService = module.get<HcmService>(HcmService);

    // Seed default balance
    await balanceRepo.insert({
      employee_id: '1',
      location_id: '1',
      balance: 10,
      last_synced_at: new Date(),
    });

    jest.clearAllMocks();
  });

  it('Submit request -> verify all rows created in DB', async () => {
    const dates = ['2099-01-01', '2099-01-02'];
    const res = await service.submitRequest('1', '1', dates);

    const request = await requestRepo.findOne({ where: { request_id: res.request_id }, relations: ['requestedDates'] });
    expect(request).toBeDefined();
    expect(request?.status).toBe(RequestStatus.PENDING);
    expect(request?.requestedDates?.length).toBe(2);
    expect(request?.requestedDates).toHaveLength(2);

    const log = await logRepo.findOne({ where: { request_id: res.request_id } });
    expect(log).toBeDefined();
    expect(log?.status).toBe(RequestStatus.PENDING);
  });

  it('Submit request -> verify availableBalance reduced', async () => {
    const dates = ['2099-01-01', '2099-01-02'];
    await service.submitRequest('1', '1', dates);

    const balance = await service.getBalance('1', '1');
    expect(balance.availableBalance).toBe(8);
    expect(balance.reservedBalance).toBe(2);
  });

  it('Submit two requests -> verify reservedBalance accumulates correctly', async () => {
    await service.submitRequest('1', '1', ['2099-01-01']);
    await service.submitRequest('1', '1', ['2099-01-02']);

    const balance = await service.getBalance('1', '1');
    expect(balance.reservedBalance).toBe(2);
    expect(balance.availableBalance).toBe(8);
  });

  it('Approve request (Success) -> verify SYNCED and balance updated', async () => {
    const res = await service.submitRequest('1', '1', ['2099-01-01']);

    mockHcmService.submitTimeOff.mockResolvedValue({ new_balance: 8, accepted_dates: ['2099-01-01'] });

    await service.approveRequest(res.request_id);

    const request = await requestRepo.findOne({ where: { request_id: res.request_id } });
    expect(request?.status).toBe(RequestStatus.SYNCED);

    const balance = await balanceRepo.findOne({ where: { employee_id: '1', location_id: '1' } });
    expect(balance?.balance).toBe(8);
    // expect(balance?.last_synced_at).toBeNow();
  });

  it('Approve request (HCM Error) -> verify status becomes SYNC_FAILED', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
      if (typeof cb === 'function') cb();
      return {} as any;
    });
    const res = await service.submitRequest('1', '1', ['2099-01-01']);

    mockHcmService.submitTimeOff.mockRejectedValue({ status: 500 }); // Mock retry exhaust

    await service.approveRequest(res.request_id);

    const request = await requestRepo.findOne({ where: { request_id: res.request_id } });
    expect(request?.status).toBe(RequestStatus.SYNC_FAILED);

    const balance = await balanceRepo.findOne({ where: { employee_id: '1', location_id: '1' } });
    expect(balance?.balance).toBe(10);
    jest.restoreAllMocks();
  });

  it('Reject PENDING request -> verify availableBalance restored', async () => {
    const res = await service.submitRequest('1', '1', ['2099-01-01']);
    await service.rejectRequest(res.request_id);

    const balance = await service.getBalance('1', '1');
    expect(balance.availableBalance).toBe(10);
    expect(balance.reservedBalance).toBe(0);
  });

  it('Cancel PENDING request -> verify availableBalance restored', async () => {
    const res = await service.submitRequest('1', '1', ['2099-01-01']);
    await service.cancelRequest(res.request_id);

    const balance = await service.getBalance('1', '1');
    expect(balance.availableBalance).toBe(10);
  });

  it('Race condition: submit two requests simultaneously exceeding balance', async () => {
    // Current balance is 10. We try to submit two requests of 6 days each.
    // However, the local validation is sequential in getBalance/submitRequest.
    // To truly test concurrency we'd need multiple transactions, but here 
    // the service handles it via a defensive balance check.

    const req1 = service.submitRequest('1', '1', ['2099-01-01', '2099-01-02', '2099-01-03', '2099-01-04', '2099-01-05', '2099-01-06']);
    const req2 = service.submitRequest('1', '1', ['2099-02-01', '2099-02-02', '2099-02-03', '2099-02-04', '2099-02-05', '2099-02-06']);

    const results = await Promise.allSettled([req1, req2]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('Batch sync: reconciliation updates local balance', async () => {
    mockHcmService.getAllBalances.mockResolvedValue([{ employee_id: '1', location_id: '1', balance: 15 }]);

    await syncService.handleDailyReconciliation();

    const balance = await balanceRepo.findOne({ where: { employee_id: '1', location_id: '1' } });
    expect(balance?.balance).toBe(15);
  });

  it('Expire: past PENDING requests become EXPIRED', async () => {
    const res = await service.submitRequest('1', '1', ['2099-01-01']);

    // Manually manipulate the date row to be in the past
    await dateRepo.update({ request_id: res.request_id }, { date: '2000-01-01' });

    await syncService.handleHourlySync();

    const request = await requestRepo.findOne({ where: { request_id: res.request_id } });
    expect(request?.status).toBe(RequestStatus.EXPIRED);
  });
});
