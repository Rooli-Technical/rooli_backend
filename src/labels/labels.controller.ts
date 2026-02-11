import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LabelService } from './labels.service';
import { AttachLabelsToPostDto } from './dto/request/attach-label-to-post.dto';
import { CreateLabelDto } from './dto/request/create-label.dto';
import { SetLabelsForPostDto } from './dto/request/set-labels-for-post.dto';
import { UpdateLabelDto } from './dto/request/update-label.dto';
import { RequireFeature } from '@/common/decorators/require-feature.decorator';
import { FeatureGuard } from '@/common/guards/feature.guard';


@ApiTags('Labels')
@ApiBearerAuth()
@Controller('/api/v1/workspaces/:workspaceId/labels')
@UseGuards(FeatureGuard)
@RequireFeature('hasLabels')
export class LabelController {
  constructor(private readonly service: LabelService) {}

  @Post()
  @ApiOperation({ summary: 'Create label' })
  create(@Param('workspaceId') workspaceId: string, @Body() dto: CreateLabelDto) {
    return this.service.create(workspaceId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List labels' })
  list(@Param('workspaceId') workspaceId: string) {
    return this.service.list(workspaceId);
  }

  @Get(':labelId')
  @ApiOperation({ summary: 'Get label' })
  get(@Param('workspaceId') workspaceId: string, @Param('labelId') labelId: string) {
    return this.service.get(workspaceId, labelId);
  }

  @Patch(':labelId')
  @ApiOperation({ summary: 'Update label' })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('labelId') labelId: string,
    @Body() dto: UpdateLabelDto,
  ) {
    return this.service.update(workspaceId, labelId, dto);
  }

  @Delete(':labelId')
  @ApiOperation({ summary: 'Delete label (detach posts or block if used)' })
  @ApiQuery({ name: 'mode', required: false, enum: ['detach', 'block'], example: 'detach' })
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('labelId') labelId: string,
    @Query('mode') mode?: 'detach' | 'block',
  ) {
    return this.service.delete(workspaceId, labelId, mode ?? 'detach');
  }

  @Get('labels/:labelId/analytics')
  @ApiOperation({ summary: 'See performance of this content pillar' })
  analytics(@Param('workspaceId') wsId: string, @Param('labelId') id: string) {
    return this.service.getLabelAnalytics(wsId, id);
  }

  @Get(':labelId/posts')
  @ApiOperation({ summary: 'List posts with this label' })
  listPosts(@Param('workspaceId') workspaceId: string, @Param('labelId') labelId: string) {
    return this.service.listPosts(workspaceId, labelId);
  }

  @Post('/posts/:postId/attach')
  @ApiOperation({ summary: 'Attach labels to a post (adds to existing)' })
  attach(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Body() dto: AttachLabelsToPostDto,
  ) {
    return this.service.attachToPost(workspaceId, postId, dto);
  }

  @Post('/posts/:postId/set')
  @ApiOperation({ summary: 'Set labels for a post (replaces existing)' })
  set(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Body() dto: SetLabelsForPostDto,
  ) {
    return this.service.setForPost(workspaceId, postId, dto);
  }

  @Delete('/posts/:postId/:labelId')
  @ApiOperation({ summary: 'Remove one label from a post' })
  removeFromPost(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Param('labelId') labelId: string,
  ) {
    return this.service.removeFromPost(workspaceId, postId, labelId);
  }

}

