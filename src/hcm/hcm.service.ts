import { Injectable, Logger, NotFoundException, ConflictException, UnprocessableEntityException, InternalServerErrorException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { catchError, lastValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

@Injectable()
export class HcmService {
  private readonly logger = new Logger(HcmService.name);

  constructor(private readonly httpService: HttpService) {}

  async submitTimeOff(employeeId: string, locationId: string, dates: string[]): Promise<{ new_balance: number, accepted_dates: string[] }> {
    this.logger.log(`Submitting time off for employee ${employeeId} at location ${locationId}`);
    
    const request$ = this.httpService.post('/time-off/requests', {
      employee_id: employeeId,
      location_id: locationId,
      dates,
    }).pipe(
      catchError((error: AxiosError) => {
        this.logger.error(`Error submitting time off: ${error.message}`, error.stack);
        if (error.response) {
          const status = error.response.status;
          if (status === 404) throw new NotFoundException();
          if (status === 409) throw new ConflictException('Date overlap with existing leave');
          if (status === 422) throw new UnprocessableEntityException('HCM rejected: insufficient balance');
        }
        throw new InternalServerErrorException('HCM unavailable');
      })
    );

    const response = await lastValueFrom(request$);
    return response.data;
  }

  async getBalance(locationId: string, employeeId: string): Promise<{ employee_id: string | number, location_id: string | number, balance: number }> {
    this.logger.log(`Getting balance for employee ${employeeId} at location ${locationId}`);
    
    const request$ = this.httpService.get(`/time-off/balances/${locationId}/${employeeId}`).pipe(
      catchError((error: AxiosError) => {
        this.logger.error(`Error getting balance: ${error.message}`, error.stack);
        if (error.response?.status === 404) {
          throw new NotFoundException();
        }
        throw new InternalServerErrorException();
      })
    );

    const response = await lastValueFrom(request$);
    return response.data;
  }

  async getAllBalances(): Promise<Array<{ employee_id: string | number, location_id: string | number, balance: number }>> {
    this.logger.log(`Getting all batch balances`);
    
    const request$ = this.httpService.get('/batch/balances').pipe(
      catchError((error: AxiosError) => {
        this.logger.error(`Error getting batch balances: ${error.message}`, error.stack);
        throw new InternalServerErrorException();
      })
    );

    const response = await lastValueFrom(request$);
    return response.data;
  }
}
