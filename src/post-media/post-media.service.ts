import { PrismaService } from '@/prisma/prisma.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import * as streamifier from 'streamifier';
import { v2 as cloudinary } from 'cloudinary';

@Injectable()
export class PostMediaService {
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