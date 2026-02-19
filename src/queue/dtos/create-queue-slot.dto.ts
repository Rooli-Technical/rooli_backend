import { Platform } from "@generated/enums";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, Min, Max, IsString, Matches, IsOptional, IsEnum, IsBoolean } from "class-validator";

export class CreateQueueSlotDto {
  @ApiProperty({
    description: 'Day of week (1=Mon ... 7=Sun). Use this consistently everywhere.',
    example: 1,
    minimum: 1,
    maximum: 7,
  })
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek: number;

  @ApiProperty({
    description: 'Time of day in 24h format in workspace timezone.',
    example: '09:00',
    pattern: '^([01]\\d|2[0-3]):([0-5]\\d)$',
  })
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'time must be HH:mm (24h)' })
  time: string;

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