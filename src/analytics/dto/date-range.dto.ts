import { IsDateString } from 'class-validator';

export class DateRangeDto {
  @IsDateString()
  from: string;

  @IsDateString()
  to: string;
}