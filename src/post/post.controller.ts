import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  Request,
  FileTypeValidator,
  ParseFilePipe,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { PostService } from './post.service';
import { RequireFeature } from '@/common/decorators/require-feature.decorator';
import { FeatureGuard } from '@/common/guards/feature.guard';
import { CreatePostDto } from './dto/request/create-post.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiStandardResponse } from '@/common/decorators/api-standard-response.decorator';
import { User } from '@generated/client';
import { ApiOperation, ApiParam, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { BulkExecuteResponseDto } from './dto/response/bulk-execute.response.dto';
import { BulkValidateResponseDto } from './dto/response/bulk-validate.dto';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { ExecuteBulkScheduleDto } from './dto/request/execute-bulk-schedule.dto';

@Controller('workspaces/:workspaceId/posts')
@UseGuards(FeatureGuard)
export class PostController {
  constructor(private readonly postService: PostService) {}

  @Post()
  create(
    @Request() req,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreatePostDto,
  ) {
    return this.postService.createPost(req.user, workspaceId, dto);
  }

  @Get()
  findAll(@Param('workspaceId') workspaceId: string) {
    return this.postService.getWorkspacePosts(workspaceId);
  }

  // ==================================
  // PHASE 1: Validate CSV
  // ==================================
  @Post('bulk/validate')
  @RequireFeature('bulkScheduling')
  @ApiOperation({
    summary: 'Validate a bulk CSV of posts for a workspace',
    description:
      'Parses CSV, validates each row, and returns a preview of posts and errors without saving anything.',
  })
  @ApiParam({ name: 'workspaceId', example: 'cmjy3lnu50002m4iaj3fuj7so' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'CSV file containing posts',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiStandardResponse(BulkValidateResponseDto)
  @UseInterceptors(FileInterceptor('file'))
  async validateCsv(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new FileTypeValidator({ fileType: 'text/csv' })],
      }),
    )
    file: Express.Multer.File,
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user,
  ) {
    if (!file) throw new BadRequestException('CSV file is required');
    return this.postService.validateBulkCsv(user, workspaceId, file.buffer);
  }


  @Post('bulk/execute')
  @RequireFeature('bulkScheduling')
  @ApiOperation({
    summary: 'Execute bulk schedule after CSV validation',
    description: 'Creates scheduled posts and destinations in the workspace.',
  })
  @ApiParam({ name: 'workspaceId', example: 'cmjy3lnu50002m4iaj3fuj7so' })
  @ApiStandardResponse(BulkExecuteResponseDto)
  async executeBulkSchedule(
    @Param('workspaceId') workspaceId: string,
    @Body() body: ExecuteBulkScheduleDto,
    @CurrentUser() user,
  ) {
    return this.postService.executeBulkSchedule(user, workspaceId, body.posts);
  }
}
