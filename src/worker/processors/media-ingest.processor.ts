import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { v2 as cloudinary } from 'cloudinary';
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

@Processor('media-ingest')
export class MediaIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(MediaIngestProcessor.name);

  constructor(private prisma: PrismaService) {
    super();
  }

  async process(job: Job<{ mediaId: string; workspaceId: string }>) {
    const { mediaId, workspaceId } = job.data;
    this.logger.log(`Starting ingest for MediaFile: ${mediaId}`);

    // 1. Fetch the Pending File
    const mediaFile = await this.prisma.mediaFile.findUnique({
      where: { id: mediaId },
    });

    if (!mediaFile || !mediaFile.publicId.startsWith('external_')) {
      this.logger.warn(`Skipping job: File not found or already processed.`);
      return;
    }

    try {
      // 2. Download the External Image (Stream)
      const response = await axios({
        url: mediaFile.url,
        method: 'GET',
        responseType: 'stream',
        timeout: 10000, // 10s timeout to prevent hanging
      });

      // 3. Pipe to Cloudinary
      const uploadResult = await new Promise<any>((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: `rooli/${workspaceId}`,
            resource_type: 'auto',
            public_id: mediaFile.filename.replace(/\.[^/.]+$/, ""), // Use filename as ID
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          },
        );
        
        response.data.pipe(uploadStream);
      });

      // 4. Update Database with Real Cloudinary Data
      await this.prisma.mediaFile.update({
        where: { id: mediaId },
        data: {
          url: uploadResult.secure_url,
          publicId: uploadResult.public_id, // Now it's a real ID
          size: BigInt(uploadResult.bytes),
          width: uploadResult.width,
          height: uploadResult.height,
          mimeType: `${uploadResult.resource_type}/${uploadResult.format}`,
        },
      });

      this.logger.log(`Successfully ingested: ${mediaFile.filename}`);

    } catch (error) {
      this.logger.error(`Failed to ingest media ${mediaId}`, error);
      // Optional: Mark file as 'FAILED' in DB or retry later
      throw error; // Throwing triggers BullMQ retry logic
    }
  }
}