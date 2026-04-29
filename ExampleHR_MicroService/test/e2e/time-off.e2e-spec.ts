import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DataSource } from 'typeorm';
import { Balance } from '../../src/time-off/entities/balance.entity';
import { RequestStatus } from '../../src/time-off/enums/request-status.enum';

describe('TimeOff E2E', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  const hcmUrl = 'http://localhost:3001';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Reset HCM (assuming it's running externally)
    await request(hcmUrl).post('/reset');

    // Reset and Seed local DB
    await dataSource.synchronize(true);
    const balanceRepo = dataSource.getRepository(Balance);
    await balanceRepo.insert([
      { employee_id: '1', location_id: '1', balance: 20, last_synced_at: new Date() }, // Alice
      { employee_id: '2', location_id: '1', balance: 10, last_synced_at: new Date() }, // Bob
      { employee_id: '3', location_id: '1', balance: 0, last_synced_at: new Date() },  // Charlie
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Full happy path: Submit -> Approve -> Balance Check', async () => {
    const dates = ['2099-01-01', '2099-01-02'];
    const res = await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employee_id: '1', location_id: '1', datesList: dates })
      .expect(201);

    const requestId = res.body.request_id;

    // GET request
    await request(app.getHttpServer())
      .get(`/time-off/requests/${requestId}`)
      .expect(200);

    // PATCH approve
    await request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`)
      .expect(200);

    // Verify balance decremented
    const balanceRes = await request(app.getHttpServer())
      .get('/time-off/balances/1/1')
      .expect(200);
    
    expect(balanceRes.body.balance).toBe(18);
  });

  it('Insufficient balance: Charlie (balance=0) should fail', async () => {
    await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employee_id: '3', location_id: '1', datesList: ['2099-01-01'] })
      .expect(422);
  });

  it('Unreliable HCM: post-sync defensive check catches negative balance', async () => {
    // 1. Submit a valid request for 6 days (Balance = 10)
    const res = await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employee_id: '2', location_id: '1', datesList: ['2099-12-01', '2099-12-02', '2099-12-03', '2099-12-04', '2099-12-05', '2099-12-06'] })
      .expect(201);

    const requestId = res.body.request_id;

    // 2. Silently reduce local balance to 3. 
    // Now availableBalance = 3 - 6 = -3.
    await dataSource.getRepository(Balance).update({ employee_id: '2', location_id: '1' }, { balance: 3 });

    // 3. Approve - syncSingleRequest will check availableBalance < 0 and REJECT it.
    await request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`)
      .expect(200);

    const requestObj = await request(app.getHttpServer()).get(`/time-off/requests/${requestId}`);
    expect(requestObj.body.status).toBe(RequestStatus.REJECTED);
  });

  it('HCM down: verify status stays SYNC_FAILED after retries', async () => {
    // Mock setTimeout only for the retry delay (10000ms)
    const setTimeoutMock = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any, ms?: number) => {
        if (ms === 10000) {
            if (typeof cb === 'function') cb();
            return {} as any;
        }
        return setTimeout(cb, ms);
    });

    // 10th global call returns 500.
    await request(hcmUrl).post('/reset');
    for (let i = 0; i < 9; i++) {
        await request(hcmUrl).get('/health');
    }

    const res = await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employee_id: '1', location_id: '1', datesList: ['2099-05-01'] })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/time-off/requests/${res.body.request_id}/approve`)
      .expect(200);

    const requestObj = await request(app.getHttpServer()).get(`/time-off/requests/${res.body.request_id}`);
    expect(requestObj.body.status).toBe(RequestStatus.SYNC_FAILED);
    setTimeoutMock.mockRestore();
  });

  it('Date overlap: expect 409', async () => {
    await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employee_id: '1', location_id: '1', datesList: ['2026-06-01'] })
      .expect(201);

    await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employee_id: '1', location_id: '1', datesList: ['2026-06-01'] })
      .expect(409);
  });

  it('Cancel flow: balance restored', async () => {
    const res = await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employee_id: '1', location_id: '1', datesList: ['2099-06-01'] })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/time-off/requests/${res.body.request_id}/cancel`)
      .expect(200);

    const balance = await request(app.getHttpServer()).get('/time-off/balances/1/1');
    expect(balance.body.availableBalance).toBe(20);
  });

  it('Reject flow: balance restored', async () => {
    const res = await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employee_id: '1', location_id: '1', datesList: ['2099-07-01'] })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/time-off/requests/${res.body.request_id}/reject`)
      .expect(200);

    const balance = await request(app.getHttpServer()).get('/time-off/balances/1/1');
    expect(balance.body.availableBalance).toBe(20);
  });
});
