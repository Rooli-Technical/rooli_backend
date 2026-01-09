import { RequireFeature } from '@/common/decorators/require-feature.decorator';
import { FeatureGuard } from '@/common/guards/feature.guard';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  Request,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { PostMediaService } from './post-media.service';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiConsumes,
  ApiQuery,
} from '@nestjs/swagger';
import { ApiStandardListResponse } from '@/common/decorators/api-standard-list-response.decorator';
import { ApiStandardResponse } from '@/common/decorators/api-standard-response.decorator';
import { MediaFileDto } from './dto/response/media-file.dto';
import { MediaFolderDto } from './dto/response/media-folder.dto';

@ApiTags('Media Library')
@Controller('workspaces/:workspaceId/media')
@UseGuards(FeatureGuard)
export class PostMediaController {
  constructor(private readonly mediaService: PostMediaService) {}

  @Post('upload')
  @ApiOperation({ summary: 'Upload a file to the media library' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  @ApiBody({
    description: 'File to upload',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        folderId: { type: 'string', nullable: true },
      },
      required: ['file'],
    },
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  @ApiStandardResponse(MediaFileDto)
  async uploadFile(
    @Request() req,
    @Param('workspaceId') wsId: string,
    @Body('folderId') folderId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 1024 * 1024 * 50 }), // 50MB
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.mediaService.uploadFile(req.user, wsId, file, folderId);
  }

  @Post('upload/multiple')
  @ApiStandardListResponse(MediaFileDto)
  @ApiOperation({ summary: 'Upload multiple media files' })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Multiple file upload payload',
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
        },
        folderId: {
          type: 'string',
          nullable: true,
          description: 'Optional folder ID to upload files into',
        },
      },
      required: ['files'],
    },
  })
  @UseInterceptors(FilesInterceptor('files', 10))
  async uploadMultipleFiles(
    @Request() req,
    @Param('workspaceId') wsId: string,
    @Body('folderId') folderId: string,
    @UploadedFiles(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 1024 * 1024 * 50 })],
      }),
    )
    files: Express.Multer.File[],
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }

    return this.mediaService.uploadMany(req.user, wsId, files, folderId);
  }

  @Get()
  @ApiOperation({ summary: 'Get media library (files and folders)' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  @ApiQuery({
    name: 'folderId',
    description: 'Optional folder ID to list contents of',
    required: false,
    type: String,
  })
  @ApiStandardListResponse(MediaFileDto)
  async getLibrary(
    @Param('workspaceId') wsId: string,
    @Query('folderId') folderId?: string,
  ) {
    return this.mediaService.getLibrary(wsId, folderId || null);
  }

  @Delete(':fileId')
  @ApiOperation({ summary: 'Delete a file from the media library' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  @ApiParam({ name: 'fileId', description: 'ID of the file to delete' })
  @ApiStandardResponse(MediaFileDto)
  async deleteFile(
    @Param('workspaceId') wsId: string,
    @Param('fileId') fileId: string,
  ) {
    const deleted = await this.mediaService.deleteFile(wsId, fileId);
    return {
      success: true,
      data: deleted,
      message: 'File deleted successfully',
    };
  }

  @Post('folders')
  @RequireFeature('mediaLibrary')
  @ApiOperation({
    summary: 'Create a new folder in the media library (Rocket Plan)',
  })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  @ApiBody({
    description: 'Folder details',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', example: 'New Folder' },
        parentId: {
          type: 'string',
          nullable: true,
          example: 'parent_folder_id',
        },
      },
      required: ['name'],
    },
  })
  @ApiStandardResponse(MediaFolderDto)
  async createFolder(
    @Param('workspaceId') wsId: string,
    @Body() body: { name: string; parentId?: string },
  ) {
    return this.mediaService.createFolder(wsId, body.name, body.parentId);
  }
}
