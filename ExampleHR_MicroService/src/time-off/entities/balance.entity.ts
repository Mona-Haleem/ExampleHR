import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('balance')
export class Balance {
  @PrimaryColumn()
  employee_id: string;

  @PrimaryColumn()
  location_id: string;

  @Column({ default: 0 })
  balance: number;

  @UpdateDateColumn()
  last_synced_at: Date;
}
