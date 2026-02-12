import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { CreateCampaignDto } from './create-campaign.dto';
import { CampaignStatus } from '@generated/enums';
import { IsOptional, IsEnum } from 'class-validator';

export class UpdateCampaignDto extends PartialType(CreateCampaignDto) {
  @ApiPropertyOptional({ enum: CampaignStatus, default: 'ACTIVE' })
  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;
}
