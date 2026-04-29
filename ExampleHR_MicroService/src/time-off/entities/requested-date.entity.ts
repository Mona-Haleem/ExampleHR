import { Entity, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { TimeOffRequest } from './time-off-request.entity';

@Entity('requested_date')
export class RequestedDate {
  @PrimaryColumn()
  request_id: string;

  @PrimaryColumn()
  date: string;

  @ManyToOne(() => TimeOffRequest, (request) => request.requestedDates, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'request_id' })
  request: TimeOffRequest;

}
