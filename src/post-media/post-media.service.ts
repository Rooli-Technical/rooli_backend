import { PrismaService } from '@/prisma/prisma.service';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as streamifier from 'streamifier';
import {
  v2 as cloudinary,
  UploadApiErrorResponse,
  UploadApiResponse,
} from 'cloudinary';

@Injectable()
export class PostMediaService {
  private readonly logger = new Logger(PostMediaService.name);
  constructor(private prisma: PrismaService) {}

  // ==========================================
  // 1. GENERATE CLOUDINARY SIGNATURE
  // ==========================================
  async generateSignature(workspaceId: string) {
    const timestamp = Math.round(new Date().getTime() / 1000);
    const folder = `rooli/${workspaceId}`;

    // Generate the signature using Cloudinary's utility
    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp: timestamp,
        folder: folder,
        resource_type: 'auto',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'mp4', 'mov', 'avi', 'mkv', 'webm'],
        max_file_size: 50 * 1024 * 1024,
      },
      process.env.CLOUDINARY_API_SECRET, // Make sure this is in your env
    );

    return {
      timestamp,
      signature,
      folder,
      apiKey: process.env.CLOUDINARY_API_KEY,
    };
  }

  // ==========================================
  // 2. SAVE METADATA (Called after frontend uploads)
  // ==========================================
  async saveMediaMetadata(
    userId: string,
    workspaceId: string,
    payload: {
      originalName: string;
      mimeType: string;
      size: number;
      secure_url: string;
      public_id: string;
      width?: number;
      height?: number;
      duration?: number;
      resource_type: string;
    },
    folderId?: string,
    skipFolderCheck: boolean = false,
  ) {
    // A. Validate Folder (if provided)
   // A. Validate Folder ONLY if we aren't skipping
    if (folderId && !skipFolderCheck) {
      const folder = await this.prisma.mediaFolder.findFirst({
        where: { id: folderId, workspaceId },
      });
      if (!folder) throw new BadRequestException('Folder not found');
    }

    try {
      // Save Metadata to Database
      const mediaFile = await this.prisma.mediaFile.create({
        data: {
          workspaceId,
          userId,
          folderId: folderId || null,

          filename: payload.originalName,
          originalName: payload.originalName,
          mimeType: payload.mimeType,
          size: BigInt(payload.size),

          url: payload.secure_url,
          publicId: payload.public_id,
          // Handle Cloudinary's auto-generated thumbnails for videos
        thumbnailUrl: this.getThumbnailUrl(payload.public_id , payload.resource_type || 'image'),

          width: payload.width || null,
          height: payload.height || null,
          duration: payload.duration ? Math.round(payload.duration) : null,

          isAiGenerated: false,
        },
      });

      return {
        ...mediaFile,
        size: mediaFile.size.toString(), // Convert BigInt for JSON safety
      };
    } catch (err) {
      this.logger.error('Failed to save media metadata', err);
      throw err;
    }
  }

  async saveMultipleMetadata(
    userId: string,
    workspaceId: string,
    files: Array<any>,
    folderId?: string,
  ) {
    // 1. Validate Folder Once (Optimization)
    if (folderId) {
      const folder = await this.prisma.mediaFolder.findFirst({
        where: { id: folderId, workspaceId },
      });
      if (!folder) throw new BadRequestException('Folder not found');
    }

    // 2. Pass TRUE to skip the redundant checks!
    const savePromises = files.map((file) =>
      this.saveMediaMetadata(userId, workspaceId, file, folderId, true),
    );

    return Promise.allSettled(savePromises);
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

    // A. Delete from DB FIRST (Let Prisma check foreign keys!)
    await this.prisma.mediaFile.delete({ where: { id: fileId } });

    // B. If DB deletion succeeds, nuke it from Cloudinary
    await cloudinary.uploader.destroy(file.publicId, {
      resource_type: file.mimeType.startsWith('video') ? 'video' : 'image',
    });

    return { success: true };
  }

  async uploadAiGeneratedBuffer(
    userId: string,
    workspaceId: string,
    buffer: Buffer,
    prompt: string,
  ) {
    // 1. Upload the raw buffer to Cloudinary
    const uploadResult = await new Promise<any>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `rooli/${workspaceId}`,
          resource_type: 'image',
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        },
      );
      uploadStream.end(buffer); // Pushes the AI buffer to the cloud
    });

    // 2. Save to Database
    const mediaFile = await this.prisma.mediaFile.create({
      data: {
        workspaceId,
        userId,
        filename: `ai-${Date.now()}.png`,
        originalName: prompt.substring(0, 50),
        mimeType: 'image/png',
        size: BigInt(buffer.length),

        url: uploadResult.secure_url,
        publicId: uploadResult.public_id,
        thumbnailUrl: uploadResult.secure_url,

        width: uploadResult.width,
        height: uploadResult.height,

        isAiGenerated: true,
      },
    });

    return {
      ...mediaFile,
      size: mediaFile.size.toString(),
    };
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

  // ------------------------------------------
  // HELPER: Stream Upload
  // ------------------------------------------

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

    try {
      // Upload to Cloudinary (Stream)
      const uploadResult = await this.uploadToCloudinary(file, workspaceId);

      // Save Metadata to Database
      const mediaFile = await this.prisma.mediaFile.create({
        data: {
          workspaceId,
          userId,
          folderId: folderId || null,

          filename: file.originalname,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: BigInt(file.size),

          url: uploadResult.secure_url,
          publicId: uploadResult.public_id,
          thumbnailUrl: this.getThumbnailUrl(uploadResult.public_id, uploadResult.resource_type || 'image'),

          width: uploadResult.width,
          height: uploadResult.height,
          duration: uploadResult.duration
            ? Math.round(uploadResult.duration)
            : null, // Videos only

          isAiGenerated: false,
        },
      });

      // Return friendly object (BigInt can be messy in JSON)
      return {
        ...mediaFile,
        size: mediaFile.size.toString(),
      };
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  private async uploadToCloudinary(
    file: Express.Multer.File,
    folderContext: string,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `rooli/${folderContext}`, // Organize in Cloudinary by Workspace ID
          resource_type: 'auto', // Auto-detect Image vs Video
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        },
      );
      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  private getThumbnailUrl(publicId: string, resourceType: string): string {
  return cloudinary.url(publicId, {
    resource_type: resourceType === 'video' ? 'video' : 'image',
    // For videos, this tells Cloudinary to return the middle-frame JPG
    // For images, this allows you to force a standard format like JPG or WebP
    format: 'jpg', 
    transformation: [
      { width: 600, crop: 'limit' }, // Optimization: Don't load 4K for a thumbnail
      { quality: 'auto' },
      { fetch_format: 'auto' }
    ],
    secure: true, // Forces https://
  });
}
}
