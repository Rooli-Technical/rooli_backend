import { Platform } from '@generated/enums';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsArray, IsEnum } from 'class-validator';

export class BulkAddProfilesDto {
  @ApiProperty({ description: 'The Connection ID containing these pages' })
  @IsString()
  @IsNotEmpty()
  connectionId: string;

  @ApiProperty({ description: 'Platform explicitly to check against the Plan limits'})
  @IsNotEmpty()
  @IsEnum(Platform)
  platform: Platform;

  @ApiProperty({
    description: 'Array of Platform IDs to add (e.g. Page IDs)',
    example: ['123456789', '987654321'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty()
  platformIds: string[];
}
