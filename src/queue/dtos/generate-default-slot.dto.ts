import { Platform } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class GenerateDefaultSlotsDto {
  @ApiProperty({
    example: ['09:00', '10:00', '14:00'],
    description: 'Array of time strings',
  })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty()
  times: string[];

  @ApiProperty({
    example: [1, 2, 3, 4, 5],
    description: 'Days of the week (1=Mon, 7=Sun)',
    required: false,
    default: [1, 2, 3, 4, 5],
  })
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  days?: number[];

  @ApiPropertyOptional({
    description:
      'Optional platform. If set, this slot only applies to that platform. If omitted or null, applies to all platforms.',
    enum: Platform,
    example: 'LINKEDIN',
  })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;
}
