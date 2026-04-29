import { IsString, IsNotEmpty, IsArray, ArrayNotEmpty } from 'class-validator';

export class CreateRequestDto {
  @IsString()
  @IsNotEmpty()
  employee_id: string;

  @IsString()
  @IsNotEmpty()
  location_id: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  datesList: string[];
}
