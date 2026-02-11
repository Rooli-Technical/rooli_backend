import { CampaignStatus } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsHexColor, IsDateString, IsEnum, IsNotEmpty, MaxLength } from 'class-validator';


export class CreateCampaignDto {
  @ApiProperty({ example: 'Black Friday 2025', description: 'The internal name of the campaign' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;

  @ApiPropertyOptional({ example: 'Marketing push for Q4 sales', description: 'Internal notes' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: '#FF5733', description: 'Hex color code for the calendar UI' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiProperty({ example: '2025-11-01T00:00:00Z', description: 'ISO 8601 Start Date' })
  @IsDateString()
  @IsNotEmpty()
  startDate: string;

  @ApiPropertyOptional({ example: '2025-11-30T23:59:59Z', description: 'ISO 8601 End Date' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ enum: CampaignStatus, default: 'ACTIVE' })
  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;
}