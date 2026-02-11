import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {  QueueSlotService } from './queue.service';
import { FeatureGuard } from '@/common/guards/feature.guard';
import { RequireFeature } from '@/common/decorators/require-feature.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AutoScheduleDto } from './dtos/auto-schedule.dto';
import { CreateQueueSlotDto } from './dtos/create-queue-slot.dto';
import { PreviewQueueDto } from './dtos/preview-queue.dto';
import { RebuildQueueDto } from './dtos/rebuild-queue.dto';
import { UpdateQueueSlotDto } from './dtos/update-queue-slot.dto';
import { Platform } from '@generated/enums';
import { GenerateDefaultSlotsDto } from './dtos/generate-default-slot.dto';

@ApiTags('Queue Slots')
@ApiBearerAuth()
@UseGuards(FeatureGuard)
@RequireFeature('queueScheduling')
@Controller('workspaces/:workspaceId')
export class QueueSlotController {
  constructor(private readonly service: QueueSlotService) {}


  @Post('queue-slots')
  @ApiOperation({ summary: 'Create a queue slot (day + time)' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  @ApiResponse({ status: 201, description: 'Queue slot created' })
  create(@Param('workspaceId') workspaceId: string, @Body() dto: CreateQueueSlotDto) {
    return this.service.createQueueSlot(workspaceId, dto);
  }

@Post('generate-defaults')
  @ApiOperation({ 
    summary: 'Generate default queue slots', 
    description: 'Creates a batch of slots based on provided times and days while checking tier limits.' 
  })
  @ApiParam({ name: 'workspaceId', description: 'The CUID of the workspace' })
  @ApiResponse({ status: 201, description: 'Slots successfully created.' })
  @ApiResponse({ status: 403, description: 'Tier limit exceeded.' })
  async generateDefaults(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: GenerateDefaultSlotsDto,
  ) {
    return await this.service.generateDefaultSlots(
      workspaceId,
      dto.times,
      dto.days,
    );
  }


  @Get('queue-slots')
  @ApiOperation({ summary: 'List queue slots' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  @ApiQuery({
    name: 'platform',
    required: false,
    enum: Platform,
    description: 'Optional platform filter',
  })
  @ApiResponse({ status: 200, description: 'Queue slots returned' })
  list(@Param('workspaceId') workspaceId: string, @Query('platform') platform?: Platform) {
    return this.service.listQueueSlots(workspaceId, platform);
  }

  @Get('queue-slots/:slotId')
  @ApiOperation({ summary: 'Get one queue slot' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  @ApiParam({ name: 'slotId', example: 'slot_123' })
  @ApiResponse({ status: 200, description: 'Queue slot returned' })
  get(@Param('workspaceId') workspaceId: string, @Param('slotId') slotId: string) {
    return this.service.getQueueSlot(workspaceId, slotId);
  }

  @Patch('queue-slots/:slotId')
  @ApiOperation({ summary: 'Update a queue slot' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  @ApiParam({ name: 'slotId', example: 'slot_123' })
  @ApiResponse({ status: 200, description: 'Queue slot updated' })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('slotId') slotId: string,
    @Body() dto: UpdateQueueSlotDto,
  ) {
    return this.service.updateQueueSlot(workspaceId, slotId, dto);
  }

  @Delete('queue-slots/:slotId')
  @ApiOperation({ summary: 'Delete a queue slot' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  @ApiParam({ name: 'slotId', example: 'slot_123' })
  @ApiResponse({ status: 200, description: 'Queue slot deleted' })
  remove(@Param('workspaceId') workspaceId: string, @Param('slotId') slotId: string) {
    return this.service.deleteQueueSlot(workspaceId, slotId);
  }

  // --------------------
  // Engine: Queue scheduling
  // --------------------

  @Get('queue/next')
  @ApiOperation({ summary: 'Get next available slot time (does not schedule anything)' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  @ApiQuery({
    name: 'platform',
    required: false,
    enum: Platform,
    description: 'Optional platform filter',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO-8601 start time (defaults to now) Optionally specify a "from" time to find the next slot after that time instead of now.',
    example: '2026-02-10T16:00:00+01:00',
  })
  @ApiResponse({
    status: 200,
    description: 'Next available time (Date serialized as ISO)',
    schema: { example: { next: '2026-02-11T08:00:00.000Z' } },
  })
  async next(
    @Param('workspaceId') workspaceId: string,
    @Query('platform') platform?:Platform,
    @Query('from') from?: string,
  ) {
    const next = await this.service.getNextAvailableSlotTime(workspaceId, platform ?? null, from);
    return { next: next.toISOString() };
  }

  @Post('queue/preview')
  @ApiOperation({ summary: 'Preview next N available slot times' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  preview(@Param('workspaceId') workspaceId: string, @Body() dto: PreviewQueueDto) {
    return this.service.previewNextSlots(workspaceId, dto);
  }

  @Post('clear')
  @ApiOperation({ 
    summary: 'Clear scheduled queue', 
    description: 'Resets all future SCHEDULED or QUEUED posts back to DRAFT status.' 
  })
  @ApiParam({ name: 'workspaceId', description: 'The CUID of the workspace' })
  @ApiQuery({ 
    name: 'platform', 
    enum: Platform, 
    required: false, 
    description: 'Filter by platform (e.g. LINKEDIN). If omitted, clears all platforms.' 
  })
  @ApiResponse({ status: 200, description: 'Queue cleared successfully.' })
  @ApiResponse({ status: 404, description: 'Workspace not found.' })
  async clearQueue(
    @Param('workspaceId') workspaceId: string,
    @Query('platform') platform?: Platform,
  ) {
    return await this.service.clearQueue(workspaceId, platform);
  }

}
