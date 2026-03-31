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
  Patch,
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
  ApiOkResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ApiStandardListResponse } from '@/common/decorators/api-standard-list-response.decorator';
import { ApiStandardResponse } from '@/common/decorators/api-standard-response.decorator';
import { MediaFileDto } from './dto/response/media-file.dto';
import { MediaFolderDto } from './dto/response/media-folder.dto';
import { MediaLibraryResponseDto } from './dto/response/media-library.dto';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { SaveMetadataDto, SaveMultipleMetadataDto } from './request/post-media.dto';

@ApiTags('Media Library')
@Controller('workspaces/:workspaceId/media')
@ApiBearerAuth()
@UseGuards(FeatureGuard)
export class PostMediaController {
  constructor(private readonly mediaService: PostMediaService) {}

  // 1. NEW ENDPOINT: Get Signature
  @Get('upload/signature')
  @ApiOperation({ summary: 'Get Cloudinary upload signature for direct frontend uploads' })
  async getUploadSignature(@CurrentUser('workspaceId') wsId: string) {
    return this.mediaService.generateSignature(wsId);
  }

  // 2. UPDATED: Save Metadata (Replaces multipart file upload)
  @Post('upload')
  @ApiOperation({ summary: 'Save media metadata after direct Cloudinary upload' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  @ApiStandardResponse(MediaFileDto)
  async saveMediaMetadata(
    @Request() req,
    @Param('workspaceId') wsId: string,
    @Body() body: SaveMetadataDto,
  ) {
    return this.mediaService.saveMediaMetadata(
      req.user.userId,
      wsId,
      body.file,
      body.folderId,
    );
  }

  // 3. UPDATED: Save Multiple Metadata
  @Post('upload/multiple')
  @ApiStandardListResponse(MediaFileDto)
  @ApiOperation({ summary: 'Save multiple media files metadata' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  async saveMultipleMetadata(
    @Request() req,
    @Param('workspaceId') wsId: string,
    @Body() body: SaveMultipleMetadataDto,
  ) {
    if (!body.files || body.files.length === 0) {
      throw new BadRequestException('No files provided');
    }

    return this.mediaService.saveMultipleMetadata(
      req.user.userId,
      wsId,
      body.files,
      body.folderId,
    );
  }

  @Get('library')
  @ApiOperation({ summary: 'Get media library (files and folders)' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace ID' })
  @ApiQuery({
    name: 'folderId',
    description: 'Optional folder ID to list contents of',
    required: false,
    type: String,
  })
  @ApiOkResponse({ type: MediaLibraryResponseDto })
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
  @ApiOkResponse({
    schema: {
      example: {
        success: true,
        data: null,
        message: 'File deleted successfully',
      },
    },
  })
  async deleteFile(
    @Param('workspaceId') wsId: string,
    @Param('fileId') fileId: string,
  ) {
    await this.mediaService.deleteFile(wsId, fileId);
    return {
      success: true,
      data: null,
      message: 'File deleted successfully',
    };
  }

  @Patch('avatar')
  @ApiOperation({
    summary: 'Update user avatar',
    description:
      'Uploads a new image, links it to the user profile, and deletes the previous avatar file.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'The workspace context for the media storage',
        },
        file: {
          type: 'string',
          format: 'binary',
          description: 'Image file (png, jpg, webp)',
        },
      },
      required: ['file', 'workspaceId'],
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
      fileFilter: (req, file, cb) => {
        if (!file.mimetype.match(/\/(jpg|jpeg|png|webp)$/)) {
          return cb(
            new BadRequestException('Only image files are allowed'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async updateAvatar(
    @CurrentUser('userId') userId: string,
    @Param('workspaceId') workspaceId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    return this.mediaService.updateUserAvatar(userId, workspaceId, file);
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
