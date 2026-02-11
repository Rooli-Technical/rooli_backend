import { Platform } from "@generated/enums";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsInt, Min, Max, IsString, Matches, IsEnum, IsBoolean } from "class-validator";

export class UpdateQueueSlotDto {
  @ApiPropertyOptional({
    description: 'Day of week (1=Mon ... 7=Sun).',
    example: 3,
    minimum: 1,
    maximum: 7,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number;

  @ApiPropertyOptional({
    description: 'Time of day in 24h format in workspace timezone.',
    example: '14:30',
    pattern: '^([01]\\d|2[0-3]):([0-5]\\d)$',
  })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'time must be HH:mm (24h)' })
  time?: string;

  @ApiPropertyOptional({
    description:
      'Optional platform. If set, this slot only applies to that platform.',
    enum: Platform,
    example: 'TWITTER',
  })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @ApiPropertyOptional({
    description: 'How many posts can be scheduled at this exact slot time.',
    example: 2,
    minimum: 1,
    maximum: 50,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  capacity?: number;

  @ApiPropertyOptional({
    description: 'Whether the slot is active.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
