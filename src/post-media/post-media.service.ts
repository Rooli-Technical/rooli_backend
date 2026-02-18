import { PrismaService } from '@/prisma/prisma.service';
import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import * as streamifier from 'streamifier';
import { v2 as cloudinary, UploadApiErrorResponse, UploadApiResponse } from 'cloudinary';

@Injectable()
export class PostMediaService {
private readonly logger = new Logger(PostMediaService.name);
  constructor(private prisma: PrismaService) {}

  // ==========================================
  // 1. UPLOAD FILE (Buffer -> Cloudinary -> DB)
  // ==========================================
  async uploadFile(userId: string , workspaceId: string, file: Express.Multer.File, folderId?: string) {
    // A. Validate Folder (if provided)
    if (folderId) {
      const folder = await this.prisma.mediaFolder.findFirst({
        where: { id: folderId, workspaceId }
      });
      if (!folder) throw new BadRequestException('Folder not found in this workspace');
    }

    // Upload to Cloudinary (Stream)
    const uploadResult = await this.uploadToCloudinary(file, workspaceId);

    // Save Metadata to Database
    const mediaFile = await this.prisma.mediaFile.create({
      data: {
        workspaceId,
        userId: userId,
        folderId: folderId || null,
        
        filename: file.originalname,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: BigInt(file.size), 
        
        url: uploadResult.secure_url,
        publicId: uploadResult.public_id,
        thumbnailUrl: this.getThumbnailUrl(uploadResult), 
        
        width: uploadResult.width,
        height: uploadResult.height,
        duration: uploadResult.duration ? Math.round(uploadResult.duration) : null, // Videos only
        
        isAiGenerated: false
      }
    });

    // Return friendly object (BigInt can be messy in JSON)
    return {
      ...mediaFile,
      size: mediaFile.size.toString() 
    };
  }

  async uploadMany(userId: string,workspaceId: string, files: Array<Express.Multer.File>, folderId?: string) {
    // 1. Validate Folder Once (Optimization)
    if (folderId) {
      const folder = await this.prisma.mediaFolder.findFirst({
        where: { id: folderId, workspaceId }
      });
      if (!folder) throw new BadRequestException('Folder not found');
    }
    
    const uploadPromises = files.map(file => this.uploadFile(userId, workspaceId, file, folderId));

    const results = await Promise.all(uploadPromises);

    return results;
  }

  // ==========================================
  // 2. FOLDER MANAGEMENT (Rocket Plan)
  // ==========================================
  async createFolder(workspaceId: string, name: string, parentId?: string) {
    return this.prisma.mediaFolder.create({
      data: {
        workspaceId,
        name,
        parentId
      }
    });
  }

  async getLibrary(workspaceId: string, folderId: string | null = null) {
    // Get Folders
    const folders = await this.prisma.mediaFolder.findMany({
      where: { workspaceId, parentId: folderId },
      orderBy: { name: 'asc' }
    });

    // Get Files
    const files = await this.prisma.mediaFile.findMany({
      where: { workspaceId, folderId: folderId },
      orderBy: { createdAt: 'desc' }
    });

    // Convert BigInt for JSON safety
    const safeFiles = files.map(f => ({ ...f, size: f.size.toString() }));

    return { folders, files: safeFiles };
  }

  // ==========================================
  // 3. DELETE (Cleanup)
  // ==========================================
  async deleteFile(workspaceId: string, fileId: string) {
    const file = await this.prisma.mediaFile.findFirst({
      where: { id: fileId, workspaceId }
    });

    if (!file) throw new BadRequestException('File not found');

    // A. Delete from Cloudinary first
    await cloudinary.uploader.destroy(file.publicId, {
      resource_type: file.mimeType.startsWith('video') ? 'video' : 'image'
    });

    // B. Delete from DB
   await this.prisma.mediaFile.delete({ where: { id: fileId } });
   return;
  }


async uploadAiGeneratedBuffer(
  userId: string, 
  workspaceId: string, 
  buffer: Buffer, 
  prompt: string 
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
    }
  });

  return {
    ...mediaFile,
    size: mediaFile.size.toString()
  };
}

  async updateUserAvatar(userId: string, workspaceId: string, file: Express.Multer.File) {
  // 1. Find the user and their CURRENT avatar ID
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { avatarId: true }
  });

  const oldAvatarId = user?.avatarId;

  // 2. Upload the new file (this creates the MediaFile record and returns the object)
  const newMedia = await this.uploadFile(userId, workspaceId, file);

  // 3. Link the new MediaFile ID to the User
  await this.prisma.user.update({
    where: { id: userId },
    data: { avatarId: newMedia.id }
  });

  // 4. Cleanup the old file (Cloudinary + DB)
  if (oldAvatarId) {
    try {
      await this.deleteFile(workspaceId, oldAvatarId);
    } catch (error: any) {
      // We log it but don't stop the request; the new avatar is already set
      this.logger.warn(`Failed to cleanup old avatar ${oldAvatarId}: ${error.message}`);
    }
  }

  return {
    message: 'Avatar updated successfully',
    avatarId: newMedia.id,
    url: newMedia.url
  };
}


  // ------------------------------------------
  // HELPER: Stream Upload
  // ------------------------------------------
  private async uploadToCloudinary(file: Express.Multer.File, folderContext: string): Promise<any> {
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

  private getThumbnailUrl(result: any): string | null {
    if (result.resource_type === 'video') {
      // Cloudinary auto-generates jpg thumbnails for videos
      return result.secure_url.replace(/\.[^/.]+$/, ".jpg");
    }
    return result.secure_url;
  }
}