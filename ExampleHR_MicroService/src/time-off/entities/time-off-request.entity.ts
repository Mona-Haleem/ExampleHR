import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, Index } from 'typeorm';
import { RequestStatus } from '../enums/request-status.enum';
import { RequestedDate } from './requested-date.entity';
import { RequestLog } from './request-log.entity';

@Entity('time_off_request')
@Index(['employee_id', 'location_id', 'status'])
@Index(['status'])
export class TimeOffRequest {
  @PrimaryColumn('uuid')
  request_id: string;

  @Column()
  employee_id: string;

  @Column()
  location_id: string;

  @Column({ type: 'varchar', default: RequestStatus.PENDING })
  status: RequestStatus;

  @CreateDateColumn()
  created_date: Date;

  @UpdateDateColumn()
  updated_date: Date;

  @OneToMany(() => RequestedDate, (requestedDate) => requestedDate.request, {
    cascade: true,
  })
  requestedDates: RequestedDate[];

  @OneToMany(() => RequestLog, (requestLog) => requestLog.request, {
    cascade: true,
  })
  logs: RequestLog[];

}
