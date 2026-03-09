import { Controller, Get, Param } from '@nestjs/common';
import { PollingService } from './polling.service';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@Controller('polling')
@ApiBearerAuth()
export class PollingController {
  constructor(private readonly pollingService: PollingService) {}

  @Get(':profileId/feed')
  @ApiOperation({ summary: 'Fetch DMs and Comments for a specific profile' })
  async getProfileInbox(
    @Param('profileId') profileId: string){
    return this.pollingService.fetchLiveData(profileId);
  }
}
