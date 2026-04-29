import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { HcmService } from './hcm.service';
import { of, throwError } from 'rxjs';
import { NotFoundException, ConflictException, UnprocessableEntityException, InternalServerErrorException } from '@nestjs/common';
import { Logger } from '@nestjs/common';

const mockHttpService = {
  post: jest.fn(),
  get: jest.fn(),
};

describe('HcmService', () => {
  let service: HcmService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmService,
        { provide: HttpService, useValue: mockHttpService },
      ],
    }).compile();

    service = module.get<HcmService>(HcmService);
    jest.clearAllMocks();

    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => { });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => { });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => { });


  });

  describe('submitTimeOff', () => {
    it('should return data on success', async () => {
      mockHttpService.post.mockReturnValue(of({ data: { new_balance: 5, accepted_dates: [] } }));
      const result = await service.submitTimeOff('1', '1', ['2026-01-01']);
      expect(result).toEqual({ new_balance: 5, accepted_dates: [] });
    });

    it('should throw NotFoundException on 404', async () => {
      mockHttpService.post.mockReturnValue(throwError(() => ({ response: { status: 404 }, message: 'Error' })));
      await expect(service.submitTimeOff('1', '1', [])).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException on 409', async () => {
      mockHttpService.post.mockReturnValue(throwError(() => ({ response: { status: 409 }, message: 'Error' })));
      await expect(service.submitTimeOff('1', '1', [])).rejects.toThrow(ConflictException);
    });

    it('should throw UnprocessableEntityException on 422', async () => {
      mockHttpService.post.mockReturnValue(throwError(() => ({ response: { status: 422 }, message: 'Error' })));
      await expect(service.submitTimeOff('1', '1', [])).rejects.toThrow(UnprocessableEntityException);
    });

    it('should throw InternalServerErrorException on network error', async () => {
      mockHttpService.post.mockReturnValue(throwError(() => new Error('Network error')));
      await expect(service.submitTimeOff('1', '1', [])).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('getBalance', () => {
    it('should return balance on success', async () => {
      mockHttpService.get.mockReturnValue(of({ data: { employee_id: 1, location_id: 1, balance: 10 } }));
      const result = await service.getBalance('1', '1');
      expect(result.balance).toBe(10);
    });

    it('should throw NotFoundException on 404', async () => {
      mockHttpService.get.mockReturnValue(throwError(() => ({ response: { status: 404 }, message: 'Error' })));
      await expect(service.getBalance('1', '1')).rejects.toThrow(NotFoundException);
    });

    it('should throw InternalServerErrorException on 500', async () => {
      mockHttpService.get.mockReturnValue(throwError(() => ({ response: { status: 500 }, message: 'Error' })));
      await expect(service.getBalance('1', '1')).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('getAllBalances', () => {
    it('should return all balances on success', async () => {
      mockHttpService.get.mockReturnValue(of({ data: [{ balance: 10 }] }));
      const result = await service.getAllBalances();
      expect(result).toHaveLength(1);
    });

    it('should throw InternalServerErrorException on 500', async () => {
      mockHttpService.get.mockReturnValue(throwError(() => ({ response: { status: 500 }, message: 'Error' })));
      await expect(service.getAllBalances()).rejects.toThrow(InternalServerErrorException);
    });
  });
});
