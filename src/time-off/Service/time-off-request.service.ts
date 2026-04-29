import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TimeOffRequest } from '../entities/time-off-request.entity';
import { RequestLog } from '../entities/request-log.entity';
import { RequestStatus } from '../enums/request-status.enum';

@Injectable()
export class TimeOffRequestService {
    constructor(
        @InjectRepository(TimeOffRequest)
        private readonly requestRepo: Repository<TimeOffRequest>,

        @InjectRepository(RequestLog)
        private readonly logRepo: Repository<RequestLog>,
    ) { }

    async updateStatus(
        requestId: string,
        newStatus: RequestStatus,
    ): Promise<TimeOffRequest> {
        const request = await this.requestRepo.findOneByOrFail({
            request_id: requestId,
        });

        request.status = newStatus;
        await this.requestRepo.save(request);

        await this.logRepo.save({
            request,
            status: newStatus,
        });

        return request;
    }

    async findAll(): Promise<TimeOffRequest[]> {
        return this.requestRepo.find({
            relations: [],
        });
    }
}