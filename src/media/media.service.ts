import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@generated/client';
import * as streamifier from 'streamifier';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  // Max size: 100MB. Consider lowering this for serverless environments (e.g., Vercel allows max 4.5MB body).
  private readonly MAX_FILE_SIZE = 100 * 1024 * 1024; 
  private readonly ALLOWED_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/quicktime', 'video/x-msvideo',
    'application/pdf' 
  ];

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // FOLDER MANAGEMENT
  // ===========================================================================

  async createFolder(name: string, organizationId: string, parentId?: string) {
    if (parentId) {
      const parent = await this.prisma.mediaFolder.findUnique({
        where: { id: parentId, organizationId },
      });
      if (!parent) throw new NotFoundException('Parent folder not found');
    }

    // Check for duplicate names in the same level
    const existing = await this.prisma.mediaFolder.findFirst({
      where: { name, organizationId, parentId: parentId || null },
    });

    if (existing) throw new BadRequestException('A folder with this name already exists here');

    return this.prisma.mediaFolder.create({
      data: { name, organizationId, parentId },
    });
  }

  async getFolderContents(organizationId: string, folderId?: string) {
    const [folders, files] = await Promise.all([
      this.prisma.mediaFolder.findMany({
        where: { organizationId, parentId: folderId || null },
        orderBy: { name: 'asc' },
      }),
      this.prisma.mediaFile.findMany({
        where: { organizationId, folderId: folderId || null },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { folders, files };
  }

  async deleteFolder(folderId: string, organizationId: string) {
    const folder = await this.prisma.mediaFolder.findUnique({
      where: { id: folderId, organizationId },
      include: { children: true, files: true },
    });

    if (!folder) throw new NotFoundException('Folder not found');

    // Prevent deletion if not empty (Safety first)
    // Or implement recursive delete (Cascade) depending on requirements. 
    // Since Prisma schema has onDelete: Cascade for files? No, SetNull.
    // Let's force cleanup or explicit recursive logic.
    if (folder.children.length > 0 || folder.files.length > 0) {
      throw new BadRequestException('Folder is not empty. Please delete contents first.');
    }

    return this.prisma.mediaFolder.delete({
      where: { id: folderId },
    });
  }

  // ===========================================================================
  // FILE MANAGEMENT
  // ===========================================================================

  async getFileById(fileId: string, organizationId?: string) {
    const where: Prisma.MediaFileWhereInput = { id: fileId };
    if (organizationId) where.organizationId = organizationId;

    const file = await this.prisma.mediaFile.findFirst({ where });
    if (!file) throw new NotFoundException('Media file not found');
    return file;
  }



  async uploadFile(
    userId: string,
    organizationId: string,
    file: Express.Multer.File,
    folderId?: string,
    isAIGenerated = false,
    aiGenerationContext?: Record<string, any>,
  ) {
    this.validateFile(file);

    // 1. Verify Folder ID if present
    if (folderId) {
      const folderExists = await this.prisma.mediaFolder.count({
        where: { id: folderId, organizationId },
      });
      if (!folderExists) throw new NotFoundException('Target folder not found');
    }

    // 2. Upload to Cloudinary via Stream
    const uploadResult = await this.uploadToCloudinaryStream(file);

    // 3. Save to DB
    return this.prisma.mediaFile.create({
      data: {
        userId,
        organizationId,
        folderId,
        filename: this.generateFilename(file.originalname),
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        url: uploadResult.secure_url,
        publicId: uploadResult.public_id,
        thumbnailUrl: uploadResult.thumbnail_url || uploadResult.secure_url, // Fallback for images
        duration: uploadResult.duration ? Math.round(uploadResult.duration) : null,
        isAIGenerated,
        aiGenerationContext: aiGenerationContext || Prisma.JsonNull,
        metadata: {
          width: uploadResult.width,
          height: uploadResult.height,
          format: uploadResult.format,
        },
      },
    });
  }


  async uploadMultipleFiles(
    files: Express.Multer.File[],
    userId: string,
    organizationId: string,
    folderId?: string,
  ) {
    if (!files.length) throw new BadRequestException('No files provided');
    files.forEach((f) => this.validateFile(f));

    if (folderId) {
      const folderExists = await this.prisma.mediaFolder.count({
        where: { id: folderId, organizationId },
      });
      if (!folderExists) throw new NotFoundException('Target folder not found');
    }

    const uploadPromises = files.map((file) => this.uploadToCloudinaryStream(file));
    
    const cloudinaryResults = await Promise.all(uploadPromises);

    // 2. Create DB Records using Transaction
    try {
      const createdFiles = await this.prisma.$transaction(
        cloudinaryResults.map((result, index) => {
          return this.prisma.mediaFile.create({
            data: {
              userId,
              organizationId,
              folderId,
              filename: this.generateFilename(files[index].originalname),
              originalName: files[index].originalname,
              mimeType: files[index].mimetype,
              size: files[index].size,
              url: result.secure_url,
              publicId: result.public_id,
              thumbnailUrl: result.thumbnail_url || result.secure_url,
              duration: result.duration ? Math.round(result.duration) : null,
              metadata: {
                width: result.width,
                height: result.height,
                format: result.format,
              },
            },
          });
        })
      );
      return createdFiles;
    } catch (error) {
      this.logger.error('DB Insert failed, cleaning up Cloudinary uploads...');
      await Promise.allSettled(
        cloudinaryResults.map(r => cloudinary.uploader.destroy(r.public_id))
      );
      throw new InternalServerErrorException('Failed to save file records');
    }
  }

  async deleteFile(fileId: string, organizationId: string) {
    const file = await this.prisma.mediaFile.findUnique({
      where: { id: fileId, organizationId },
    });
    if (!file) throw new NotFoundException('File not found');

    await this.deleteFromCloudinary(file.publicId, file.mimeType);
    await this.prisma.mediaFile.delete({ where: { id: fileId } });

    return { message: 'File deleted successfully', id: fileId };
  }

  async deleteMultipleFiles(fileIds: string[], organizationId: string) {
    if (!fileIds.length) throw new BadRequestException('No file IDs provided');

    const files = await this.prisma.mediaFile.findMany({
      where: { id: { in: fileIds }, organizationId },
    });

    if (!files.length) throw new NotFoundException('No matching files found');

    // 1. Delete from Cloudinary
    await Promise.allSettled(
      files.map((f) => this.deleteFromCloudinary(f.publicId, f.mimeType))
    );

    // 2. Delete from DB
    await this.prisma.mediaFile.deleteMany({
      where: { id: { in: fileIds } },
    });

    return { message: `Successfully deleted ${files.length} files` };
  }

  // ===========================================================================
  // CRON JOBS
  // ===========================================================================

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredFiles() {
    this.logger.log('Running expired files cleanup...');
    const now = new Date();
    
    // Batch processing to avoid memory issues if there are thousands of expired files
    const BATCH_SIZE = 50;
    
    while (true) {
      const expiredFiles = await this.prisma.mediaFile.findMany({
        where: { expiresAt: { lte: now } },
        take: BATCH_SIZE,
      });

      if (expiredFiles.length === 0) break;

      // Process batch
      const idsToDelete = expiredFiles.map(f => f.id);
      
      // Delete from Cloudinary
      await Promise.allSettled(
        expiredFiles.map(f => this.deleteFromCloudinary(f.publicId, f.mimeType))
      );

      // Delete from DB
      await this.prisma.mediaFile.deleteMany({
        where: { id: { in: idsToDelete } }
      });
      
      this.logger.log(`Deleted batch of ${expiredFiles.length} expired files`);
    }
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Wraps Cloudinary Upload in a Stream
   * This keeps RAM usage low even for large files
   */
  private uploadToCloudinaryStream(file: Express.Multer.File): Promise<any> {
    return new Promise((resolve, reject) => {
      const resourceType = file.mimetype.startsWith('video/') ? 'video' : 'image';
      
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: resourceType,
          folder: 'organization_uploads', 
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        },
      );

      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  private async deleteFromCloudinary(publicId: string, mimeType: string) {
    if (!publicId) return;
    const resourceType = mimeType.startsWith('video/') ? 'video' : 'image';
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch (err) {
      this.logger.error(`Failed to delete Cloudinary resource: ${publicId}`, err);
    }
  }

  private generateFilename(originalName: string): string {
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 8);
    const extension = originalName.split('.').pop()?.toLowerCase() || 'bin';
    return `file_${timestamp}_${randomString}.${extension}`;
  }

  private validateFile(file: Express.Multer.File) {
    if (!this.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(`File type ${file.mimetype} is not allowed`);
    }
    if (file.size > this.MAX_FILE_SIZE) {
      throw new BadRequestException(`File too large. Max size is ${this.MAX_FILE_SIZE / 1024 / 1024}MB`);
    }
  }
}