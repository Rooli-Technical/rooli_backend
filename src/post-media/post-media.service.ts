import { PrismaService } from '@/prisma/prisma.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { v2 as cloudinary, UploadApiOptions } from 'cloudinary';
import * as fs from 'fs/promises';
import pLimit from 'p-limit';
import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PostMediaService {
  private readonly logger = new Logger(PostMediaService.name);

  // Class property, not a loose const
  private readonly ALLOWED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/quicktime',
    'video/webm',
  ]);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  // ==========================================
  // 1. UPLOAD FILE (Smartly handles Buffer or Path)
  // ==========================================
  async uploadFile(
    userId: string,
    workspaceId: string,
    file: Express.Multer.File,
    folderId?: string,
  ) {
    // A. Validate Folder (if provided)
    if (folderId) {
      const folder = await this.prisma.mediaFolder.findFirst({
        where: { id: folderId, workspaceId },
      });
      if (!folder)
        throw new BadRequestException('Folder not found in this workspace');
    }

    // B. Safe Magic Byte Validation
    let detected;
    if (file.buffer) {
      detected = await fileTypeFromBuffer(file.buffer);
    } else if (file.path) {
      // Reads only the first chunk from disk, preserving RAM
      detected = await fileTypeFromFile(file.path);
    }

    if (!detected || !this.ALLOWED_MIME_TYPES.has(detected.mime)) {
      // Cleanup temp file if it was a rejected disk upload
      if (file.path) await fs.unlink(file.path).catch(() => {});
      throw new BadRequestException(
        `File type not allowed: ${detected?.mime ?? 'unknown'}`,
      );
    }

    try {
      // C. Upload to Cloudinary (Routes to buffer or path logic)
      const uploadResult = await this.processCloudinaryUpload(
        file,
        workspaceId,
      );

      // D. Save to DB
      const mediaFile = await this.prisma.mediaFile.create({
        data: {
          workspaceId,
          userId,
          folderId: folderId || null,
          filename: file.originalname,
          originalName: file.originalname,
          mimeType: detected.mime, // use verified mime
          size: BigInt(file.size),
          url: uploadResult.secure_url,
          publicId: uploadResult.public_id,
          thumbnailUrl: this.getThumbnailUrl(uploadResult),
          width: uploadResult.width,
          height: uploadResult.height,
          duration: uploadResult.duration
            ? Math.round(uploadResult.duration)
            : null,
          isAiGenerated: false,
        },
      });

      return { ...mediaFile, size: mediaFile.size.toString() };
    } catch (err) {
      this.logger.error('Upload failed', err);
      // Ensure disk cleanup on failure
      if (file.path) await fs.unlink(file.path).catch(() => {});
      throw err;
    }
  }

  async uploadMany(
    userId: string,
    workspaceId: string,
    files: Express.Multer.File[],
    folderId?: string,
  ) {
    const limit = pLimit(3); // max 3 concurrent uploads
    return Promise.all(
      files.map((file) =>
        limit(() => this.uploadFile(userId, workspaceId, file, folderId)),
      ),
    );
  }

  // ==========================================
  // 2. AI & AVATAR HELPERS
  // ==========================================
  async uploadAiGeneratedBuffer(
    userId: string,
    workspaceId: string,
    buffer: Buffer,
    prompt: string,
  ) {
    const uploadResult = await this.uploadBufferToCloudinary(buffer, {
      folder: `rooli/${workspaceId}`,
      resource_type: 'image',
    });

    const mediaFile = await this.prisma.mediaFile.create({
      data: {
        workspaceId,
        userId,
        filename: `ai-${Date.now()}.png`,
        originalName: prompt.substring(0, 50),
        mimeType: 'image/png',
        size: BigInt(buffer.length),
        url: uploadResult.secure_url, // Fixed variable reference
        publicId: uploadResult.public_id,
        thumbnailUrl: uploadResult.secure_url,
        width: uploadResult.width,
        height: uploadResult.height,
        isAiGenerated: true,
      },
    });

    return { ...mediaFile, size: mediaFile.size.toString() };
  }

  // (updateUserAvatar, createFolder, getLibrary, deleteFile remain largely identical and correct from your snippet)

  // ==========================================
  // 3. PRIVATE UPLOAD HELPERS
  // ==========================================

  // Smart router for Multer's MemoryStorage vs DiskStorage
  private async processCloudinaryUpload(
    file: Express.Multer.File,
    workspaceId: string,
  ): Promise<any> {
    const opts: UploadApiOptions = {
      folder: `rooli/${workspaceId}`,
      resource_type: 'auto',
    };

    if (file.buffer) {
      // MEMORY STORAGE (Images)
      return this.uploadBufferToCloudinary(file.buffer, opts);
    } else if (file.path) {
      // DISK STORAGE (Videos)
      const isLarge = file.size > 100 * 1024 * 1024; // 100MB
      const uploadFn = isLarge
        ? cloudinary.uploader.upload_large
        : cloudinary.uploader.upload;
      if (isLarge) opts.chunk_size = 6_000_000;

      const uploadResult = await new Promise((resolve, reject) => {
        uploadFn(file.path, opts, (error, result) => {
          if (error) return reject(error);
          resolve(result);
        });
      });

      // Crucial: Clean up the temp file after disk upload
      await fs
        .unlink(file.path)
        .catch((err) => this.logger.error('Failed to delete temp file', err));
      return uploadResult;
    }

    throw new BadRequestException(
      'Invalid file format: No buffer or path found.',
    );
  }

  private uploadBufferToCloudinary(
    buffer: Buffer,
    opts: UploadApiOptions,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(opts, (err, result) =>
        err ? reject(err) : resolve(result),
      );
      stream.end(buffer);
    });
  }

  private getThumbnailUrl(result: any): string | null {
    if (result.resource_type === 'video') {
      return result.secure_url
        .replace('/upload/', '/upload/so_0/')
        .replace(/\.[^/.]+$/, '.jpg');
    }
    return result.secure_url;
  }

  // ==========================================
  // 2. FOLDER MANAGEMENT (Rocket Plan)
  // ==========================================
  async createFolder(workspaceId: string, name: string, parentId?: string) {
    return this.prisma.mediaFolder.create({
      data: {
        workspaceId,
        name,
        parentId,
      },
    });
  }

  async getLibrary(workspaceId: string, folderId: string | null = null) {
    // Get Folders
    const folders = await this.prisma.mediaFolder.findMany({
      where: { workspaceId, parentId: folderId },
      orderBy: { name: 'asc' },
    });

    // Get Files
    const files = await this.prisma.mediaFile.findMany({
      where: { workspaceId, folderId: folderId },
      orderBy: { createdAt: 'desc' },
    });

    // Convert BigInt for JSON safety
    const safeFiles = files.map((f) => ({ ...f, size: f.size.toString() }));

    return { folders, files: safeFiles };
  }

  // ==========================================
  // 3. DELETE (Cleanup)
  // ==========================================
  async deleteFile(workspaceId: string, fileId: string) {
    const file = await this.prisma.mediaFile.findFirst({
      where: { id: fileId, workspaceId },
    });
    if (!file) throw new BadRequestException('File not found');

    // Cloudinary first — if this fails, DB record still exists,
    // so you can retry the deletion later
    await cloudinary.uploader.destroy(file.publicId, {
      resource_type: file.mimeType.startsWith('video') ? 'video' : 'image',
    });

    // DB last — only runs if cloud deletion succeeded
    await this.prisma.mediaFile.delete({ where: { id: fileId } });

    return { success: true };
  }

  async updateUserAvatar(
    userId: string,
    workspaceId: string,
    file: Express.Multer.File,
  ) {
    // 1. Find the user and their CURRENT avatar ID
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarId: true },
    });

    const oldAvatarId = user?.avatarId;

    // 2. Upload the new file (this creates the MediaFile record and returns the object)
    const newMedia = await this.uploadFile(userId, workspaceId, file);

    // 3. Link the new MediaFile ID to the User
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarId: newMedia.id },
    });

    // 4. Cleanup the old file (Cloudinary + DB)
    if (oldAvatarId) {
      try {
        await this.deleteFile(workspaceId, oldAvatarId);
      } catch (error: any) {
        // We log it but don't stop the request; the new avatar is already set
        this.logger.warn(
          `Failed to cleanup old avatar ${oldAvatarId}: ${error.message}`,
        );
      }
    }

    return {
      message: 'Avatar updated successfully',
      avatarId: newMedia.id,
      url: newMedia.url,
    };
  }

  async getSignedUploadParams(
    workspaceId: string,
    userId: string,
    fileMeta: { filename: string; size: number; mimeType: string },
  ) {
    // ========================================
    // 1. VALIDATE MIME TYPE
    // ========================================
    if (!this.ALLOWED_MIME_TYPES.has(fileMeta.mimeType)) {
      throw new BadRequestException(
        `File type not allowed: ${fileMeta.mimeType}`,
      );
    }

    // ========================================
    // 2. VALIDATE SIZE (basic — plan limits can be added later)
    // ========================================
    const MAX_SIZE = 500 * 1024 * 1024;
    if (fileMeta.size <= 0 || fileMeta.size > MAX_SIZE) {
      throw new BadRequestException('Invalid file size');
    }

    // ========================================
    // 3. CREATE PENDING_UPLOAD ROW
    // Frontend uses this ID immediately in createPost,
    // even while the upload is still in flight.
    // ========================================
    const pending = await this.prisma.mediaFile.create({
      data: {
        workspaceId,
        userId,
        filename: fileMeta.filename,
        originalName: fileMeta.filename,
        mimeType: fileMeta.mimeType,
        size: BigInt(fileMeta.size),
        status: 'PENDING_UPLOAD',
        // url and publicId default to '' — webhook fills them in
      },
    });

    // ========================================
    // 4. BUILD SIGNED CLOUDINARY PARAMS
    // ========================================
    const timestamp = Math.round(Date.now() / 1000);
    const folder = `rooli/${workspaceId}`;
    const publicId = pending.id;
    const notificationUrl = `${this.config.get('API_URL')}/webhooks/cloudinary`;

    // Cloudinary's api_sign_request signs params in alphabetical order.
    // Whatever we sign here, the frontend MUST send exactly the same values.
    const paramsToSign: Record<string, string | number> = {
      context: `mediaFileId=${pending.id}`,
      folder,
      notification_url: notificationUrl,
      public_id: publicId,
      timestamp,
    };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      this.config.get('CLOUDINARY_API_SECRET'),
    );

    // ========================================
    // 5. RETURN EVERYTHING THE FRONTEND NEEDS
    // ========================================
    return {
      mediaFileId: pending.id,
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.config.get('CLOUDINARY_CLOUD_NAME')}/auto/upload`,
      params: {
        ...paramsToSign,
        signature,
        api_key: this.config.get('CLOUDINARY_API_KEY'),
      },
    };
  }
}
