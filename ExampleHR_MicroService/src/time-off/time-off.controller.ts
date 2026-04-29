import { Controller, Post, Body, Get, Param, Query, Patch } from '@nestjs/common';
import { TimeOffService } from './time-off.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { RequestStatus } from './enums/request-status.enum';

@Controller('time-off')
export class TimeOffController {
  constructor(private readonly timeOffService: TimeOffService) {}

  @Post('requests')
  async submitRequest(@Body() createRequestDto: CreateRequestDto) {
    const { employee_id, location_id, datesList } = createRequestDto;
    return this.timeOffService.submitRequest(employee_id, location_id, datesList);
  }

  @Get('requests')
  async getAllRequests(
    @Query('status') status?: RequestStatus,
    @Query('employeeId') employeeId?: string,
  ) {
    return this.timeOffService.getAllRequests({ status, employeeId });
  }

  @Get('requests/:requestId')
  async getRequest(@Param('requestId') requestId: string) {
    return this.timeOffService.getRequest(requestId);
  }

  @Patch('requests/:requestId/approve')
  async approveRequest(@Param('requestId') requestId: string) {
    return this.timeOffService.approveRequest(requestId);
  }

  @Patch('requests/:requestId/reject')
  async rejectRequest(@Param('requestId') requestId: string) {
    return this.timeOffService.rejectRequest(requestId);
  }

  @Patch('requests/:requestId/cancel')
  async cancelRequest(@Param('requestId') requestId: string) {
    return this.timeOffService.cancelRequest(requestId);
  }

  @Get('balances/:locationId/:employeeId')
  async getBalance(
    @Param('locationId') locationId: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.timeOffService.getBalance(employeeId, locationId);
  }
}
