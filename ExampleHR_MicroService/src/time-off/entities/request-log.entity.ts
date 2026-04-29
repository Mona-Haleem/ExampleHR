import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { TimeOffRequest } from './time-off-request.entity';
import { RequestStatus } from '../enums/request-status.enum';

@Entity('request_log')
export class RequestLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('uuid')
  request_id: string;

  @Column({ type: 'varchar' })
  status: RequestStatus;

  @CreateDateColumn({ default: Date.now() })
  last_edited: Date;

  @ManyToOne(() => TimeOffRequest, (request) => request.logs, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'request_id' })
  request: TimeOffRequest;

}
