import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import { ISocialProvider, SocialCredentials } from '../interfaces/social-provider.interface';

@Injectable()
export class LinkedInProvider implements ISocialProvider {
  private readonly logger = new Logger(LinkedInProvider.name);
  private readonly API_BASE = 'https://api.linkedin.com';
  // ⚠️ ALWAYS CHECK FOR LATEST VERSION (Currently ~202501)
  private readonly API_VERSION = '202501';

  constructor(private readonly configService: ConfigService) {}

async publish(
    credentials: SocialCredentials,
    content: string,
    mediaFiles: { url: string; mimeType: string; title?: string }[], // Added 'title' to type
    metadata: { authorUrn: string },
  ) {
    if (!metadata?.authorUrn) throw new BadRequestException('Author URN required');

    try {
      const mediaUrns: { id: string; title?: string }[] = [];

      // --- A. VALIDATION: Check counts ---
      const videoCount = mediaFiles.filter(f => f.mimeType.startsWith('video/')).length;
      const imageCount = mediaFiles.filter(f => f.mimeType.startsWith('image/')).length;
      const docCount = mediaFiles.filter(f => f.mimeType === 'application/pdf').length;

      // Rule: Documents must be standalone
      if (docCount > 0 && (videoCount > 0 || imageCount > 0)) {
        throw new BadRequestException('LinkedIn Documents (PDFs) cannot be mixed with images or videos.');
      }
      if (docCount > 1) {
        throw new BadRequestException('LinkedIn allows only 1 Document (PDF) per post.');
      }
      if (videoCount > 1) {
        throw new BadRequestException('LinkedIn allows only 1 Video per post.');
      }

      // --- B. UPLOAD STEP ---
      for (const file of mediaFiles) {
        let result: string | { id: string; title?: string };

        if (file.mimeType.startsWith('image/')) {
          result = await this.uploadImageStream(credentials.accessToken, metadata.authorUrn, file);
          mediaUrns.push({ id: result, title: file.title });
        } 
        else if (file.mimeType.startsWith('video/')) {
          result = await this.uploadVideo(credentials.accessToken, metadata.authorUrn, file);
          mediaUrns.push({ id: result, title: file.title });
        } 
        else if (file.mimeType === 'application/pdf') {
          // 📄 Handle PDF
          const docInfo = await this.uploadDocument(credentials.accessToken, metadata.authorUrn, file);
          mediaUrns.push(docInfo);
        }
      }

      // --- C. PAYLOAD BUILDER ---
      const postBody: any = {
        author: metadata.authorUrn,
        commentary: content,
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      };

      if (mediaUrns.length > 0) {
        // CASE 1: Single Asset (Video OR Document OR Single Image)
        if (mediaUrns.length === 1 && docCount === 1) {
             // 📄 Document Payload
             postBody.content = {
               media: {
                 id: mediaUrns[0].id,
                 title: mediaUrns[0].title || 'Document', // 👈 Critical for PDF Sliders
               }
             };
        } else if (mediaUrns.length === 1) {
             // 🎥 Video or 🖼️ Single Image
             postBody.content = {
               media: {
                 id: mediaUrns[0].id,
                 title: mediaUrns[0].title || 'Shared Media',
               }
             };
        }
        // CASE 2: Multi-Image Carousel
        else {
          postBody.content = {
            multiImage: {
              images: mediaUrns.map((m) => ({
                id: m.id,
                altText: m.title || 'Image',
              })),
            },
          };
        }
      }

      // --- D. EXECUTE ---
      const response = await axios.post(`${this.API_BASE}/rest/posts`, postBody, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': this.API_VERSION,
          'Content-Type': 'application/json',
        },
      });

      const urn = response.headers['x-restli-id'] || response.data.id;
      return {
        platformPostId: urn,
        url: `https://www.linkedin.com/feed/update/${urn}`,
      };

    } catch (error) {
      this.handleError(error);
    }
  }

  // ==================================================
  // 📸 IMAGE UPLOAD (Simple Stream)
  // ==================================================
  private async uploadImageStream(
    token: string,
    authorUrn: string,
    file: { url: string; mimeType: string },
  ): Promise<string> {
    // A. Initialize
    const registerBody = {
      initializeUploadRequest: {
        owner: authorUrn,
      },
    };

    const initResp = await axios.post(
      `${this.API_BASE}/rest/images?action=initializeUpload`,
      registerBody,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': this.API_VERSION,
        },
      },
    );

    const uploadUrl = initResp.data.value.uploadUrl;
    const assetUrn = initResp.data.value.image;

    // B. Upload
    const fileStream = await axios.get(file.url, { responseType: 'stream' });
    await axios.put(uploadUrl, fileStream.data, {
      headers: { 'Content-Type': file.mimeType },
      maxBodyLength: Infinity,
    });

    return assetUrn;
  }

  // ==================================================
  // 🎥 VIDEO UPLOAD (Chunked / 3-Step Flow)
  // ==================================================
  private async uploadVideo(
    token: string,
    authorUrn: string,
    file: { url: string; mimeType: string },
  ): Promise<string> {
    // 1. Download to Temp File (Needed to calculate exact size and handle chunks)
    const tmpDir = os.tmpdir();
    const tempFilePath = path.join(tmpDir, `rooli-vid-${randomUUID()}.mp4`);
    
    try {
      this.logger.log(`Downloading video to temp for processing: ${file.url}`);
      const downloadStream = await axios.get(file.url, { responseType: 'stream' });
      await pipeline(downloadStream.data, fs.createWriteStream(tempFilePath));
      
      const stats = fs.statSync(tempFilePath);
      const fileSizeBytes = stats.size;

      // 2. Initialize Video Upload
      const initBody = {
        initializeUploadRequest: {
          owner: authorUrn,
          fileSizeBytes: fileSizeBytes, // 👈 Critical for Video
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      };

      const initResp = await axios.post(
        `${this.API_BASE}/rest/videos?action=initializeUpload`,
        initBody,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': this.API_VERSION,
            'Content-Type': 'application/json',
          },
        },
      );

      const instructions = initResp.data.value.uploadInstructions; // Array of chunks
      const uploadToken = initResp.data.value.uploadToken;
      const videoUrn = initResp.data.value.video;
      const partEtags: string[] = [];

      this.logger.log(`Uploading video in ${instructions.length} part(s)...`);

      // 3. Upload Each Part
      for (const instruction of instructions) {
        const { uploadUrl, firstByte, lastByte } = instruction;
        
        // Read specific byte range from disk
        const fileStream = fs.createReadStream(tempFilePath, {
          start: firstByte,
          end: lastByte,
        });

        const partResp = await axios.put(uploadUrl, fileStream, {
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          maxBodyLength: Infinity,
        });

        // Collect ETag (Required for Finalize)
        partEtags.push(partResp.headers['etag']);
      }

      // 4. Finalize Upload
      const finalizeBody = {
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken: uploadToken,
          uploadedPartIds: partEtags, // 👈 Must match the order of parts
        },
      };

      await axios.post(
        `${this.API_BASE}/rest/videos?action=finalizeUpload`,
        finalizeBody,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': this.API_VERSION,
            'Content-Type': 'application/json',
          },
        },
      );

      this.logger.log('Video upload finalized.');
      return videoUrn;

    } catch (error) {
      this.logger.error(`Video upload failed: ${file.url}`, error);
      throw new InternalServerErrorException('LinkedIn Video Upload Failed');
    } finally {
      // 5. Cleanup Temp File
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }

  // ==================================================
  // 📄 DOCUMENT UPLOAD (PDFs for "Sliders")
  // ==================================================
  private async uploadDocument(
    token: string,
    authorUrn: string,
    file: { url: string; mimeType: string; title?: string },
  ): Promise<{ id: string; title: string }> {
    // 1. Initialize Document Upload
    const initBody = {
      initializeUploadRequest: {
        owner: authorUrn,
      },
    };

    const initResp = await axios.post(
      `${this.API_BASE}/rest/documents?action=initializeUpload`,
      initBody,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': this.API_VERSION,
          'Content-Type': 'application/json',
        },
      },
    );

    const uploadUrl = initResp.data.value.uploadUrl;
    const docUrn = initResp.data.value.document; // e.g. urn:li:document:123...

    // 2. Stream Upload
    this.logger.log(`Uploading PDF to LinkedIn: ${docUrn}`);
    const fileStream = await axios.get(file.url, { responseType: 'stream' });

    await axios.put(uploadUrl, fileStream.data, {
      headers: {
        'Content-Type': file.mimeType,
      },
      maxBodyLength: Infinity,
    });

    return { 
      id: docUrn, 
      // Use provided title or fallback to a default (Visible to users!)
      title: file.title || 'Presentation', 
    };
  }

  private handleError(error: any) {
    const msg = error.response?.data?.message || error.message;
    this.logger.error('LinkedIn API Error', JSON.stringify(error.response?.data || error));
    throw new InternalServerErrorException(`LinkedIn Failed: ${msg}`);
  }
}