import { PrismaService } from '@/prisma/prisma.service';
import { User } from '@generated/client';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { CreatePostDto } from './dto/request/create-post.dto';
import csv from 'csv-parser';
import { Readable } from 'stream';
import { BulkCsvRow, BulkValidationError, PreparedPost } from './interfaces/post.interface';

@Injectable()
export class PostService {
  constructor(private prisma: PrismaService) {}

  async createPost(user: User, workspaceId: string, dto: CreatePostDto) {
    //  VALIDATE: Feature Access
    this.validateFeatures(user, dto);

    // VALIDATE: Do these profiles belong to this workspace?
    const validProfiles = await this.prisma.socialProfile.findMany({
      where: {
        id: { in: dto.socialProfileIds },
        workspaceId: workspaceId,
      },
      select: { id: true },
    });

    if (validProfiles.length !== dto.socialProfileIds.length) {
      throw new BadRequestException(
        'One or more selected profiles do not belong to this workspace.',
      );
    }

    // DETERMINE STATUS
    let status: 'DRAFT' | 'SCHEDULED' | 'PENDING_APPROVAL' = 'DRAFT';

    if (dto.needsApproval) {
      status = 'PENDING_APPROVAL';
    } else if (dto.scheduledAt || dto.isAutoSchedule) {
      status = 'SCHEDULED';
    }

    // TRANSACTION: Create everything at once
    return this.prisma.$transaction(async (tx) => {
      //  Create the Master Post
      const post = await tx.post.create({
        data: {
          workspaceId,
          authorId: user.id,
          content: dto.content,
          contentType: dto.contentType,
          status: status,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
          isAutoSchedule: dto.isAutoSchedule,
          timezone: dto.timezone,
          campaignId: dto.campaignId,

          // Labels (Connect existing labels)
          labels: dto.labelIds
            ? {
                connect: dto.labelIds.map((id) => ({ id })),
              }
            : undefined,
        },
      });

      //  Link Media (Preserve Order!)
      if (dto.mediaIds && dto.mediaIds.length > 0) {
        // We map them explicitly to save the 'order' index
        const mediaData = dto.mediaIds.map((mediaId, index) => ({
          postId: post.id,
          mediaFileId: mediaId,
          order: index, // 0, 1, 2... Critical for Carousels
        }));

        await tx.postMedia.createMany({ data: mediaData });
      }

      // Create Destinations (The "Omnichannel" part)
      // We create one entry for every profile selected (FB, IG, LinkedIn)
      const destinationData = validProfiles.map((profile) => ({
        postId: post.id,
        socialProfileId: profile.id,
        status: 'SCHEDULED' as const, // Default state
      }));

      await tx.postDestination.createMany({ data: destinationData });

      // D. Handle Approval (If requested)
      if (dto.needsApproval) {
        await tx.postApproval.create({
          data: {
            postId: post.id,
            requesterId: user.id,
            status: 'PENDING',
          },
        });
      }

      // Return the full object
      return post;
    });
  }

  /**
   * Helper to check Pricing Limits
   */
  private validateFeatures(user: User, dto: CreatePostDto) {
    // We navigate safely in case 'features' is not flattened
    const features =
      user['features'] ||
      user['organization']?.subscription?.plan?.features ||
      {};

    // Check Approval Access
    if (dto.needsApproval && !features.approvalWorkflow) {
      throw new ForbiddenException(
        'Upgrade to Business Plan to use Approval Workflows',
      );
    }

    // Check Campaign Access
    if (dto.campaignId && !features.hasCampaigns) {
      throw new ForbiddenException('Upgrade to Rocket Plan to use Campaigns');
    }
  }

  async getWorkspacePosts(workspaceId: string) {
    return this.prisma.post.findMany({
      where: { workspaceId },
      include: {
        destinations: { include: { profile: true } }, // See where it's going
        media: { include: { mediaFile: true }, orderBy: { order: 'asc' } }, // See images in order
        author: { select: { email: true, firstName: true } },
        campaign: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async validateBulkCsv(user: any, workspaceId: string, fileBuffer: Buffer) {
    this.ensureBulkFeature(user);

    const rows = await this.parseCsv<BulkCsvRow>(fileBuffer);

    // Fetch All Profiles (For Name AND ID lookup)
    const workspaceProfiles = await this.prisma.socialProfile.findMany({
      where: { workspaceId },
      select: { id: true, name: true, platform: true },
    });

    // Create Maps for fast lookup
    const idMap = new Set(workspaceProfiles.map((p) => p.id));
    const nameMap = new Map(
      workspaceProfiles.map((p) => [p.name.toLowerCase().trim(), p.id]),
    );

    const validPosts: PreparedPost[] = [];
    const errors: BulkValidationError[] = [];

    rows.forEach((row, index) => {
      const rowNum = index + 1;
      try {
        if (!row.content) {
          throw new Error('Content is required');
        }

        if (!row.scheduled_at) {
          throw new Error('scheduled_at is required');
        }

        if (!row.profile_ids) {
          throw new Error('profile_ids is required');
        }

        const scheduledAt = new Date(row.scheduled_at);
        if (isNaN(scheduledAt.getTime())) {
          throw new Error('Invalid scheduled_at (must be ISO 8601 UTC)');
        }

        if (scheduledAt < new Date()) {
          throw new Error('Cannot schedule posts in the past');
        }

        // 2. INTELLIGENT PROFILE MATCHING
        const rawInputs =
          row.profile_ids?.split('|').map((s) => s.trim()) || [];
        const resolvedIds: string[] = [];

        for (const input of rawInputs) {
          if (idMap.has(input)) {
            // Exact ID match
            resolvedIds.push(input);
          } else if (nameMap.has(input.toLowerCase())) {
            // Name match (e.g. "Nike Facebook")
            resolvedIds.push(nameMap.get(input.toLowerCase()));
          } else {
            throw new Error(`Could not find profile: '${input}'`);
          }
        }

        if (resolvedIds.length === 0)
          throw new Error('No valid profiles found');

        validPosts.push({
          content: row.content,
          scheduledAt: new Date(row.scheduled_at),
          profileIds: resolvedIds,
          mediaUrl: row.media_url,
        });
      } catch (err) {
        errors.push({ row: rowNum, message: err.message });
      }
    });

    return { validPosts, errors };
  }

  async executeBulkSchedule(
    user: any,
    workspaceId: string,
    posts: PreparedPost[],
  ) {
    this.ensureBulkFeature(user);

    if (!posts || posts.length === 0)
      throw new BadRequestException('No posts provided');

    // ==================================================
  //  SECURITY CHECK 1: OWNERSHIP RE-VALIDATION
  // ==================================================
  
  // Extract all unique Profile IDs the user is trying to touch
  const requestedProfileIds = new Set<string>();
  posts.forEach(p => p.profileIds.forEach(id => requestedProfileIds.add(id)));
  const uniqueIds = Array.from(requestedProfileIds);

  // Ask DB: "Count how many of THESE IDs belong to THIS Workspace"
  const count = await this.prisma.socialProfile.count({
    where: {
      id: { in: uniqueIds },
      workspaceId: workspaceId, 
    },
  });

  // If the DB found fewer profiles than requested, someone is lying (or spoofing)
  if (count !== uniqueIds.length) {
    throw new ForbiddenException(
      'Security Alert: One or more profiles do not belong to this workspace.'
    );
  }

  // ==================================================
  // SECURITY CHECK 2: TIME & CONTENT
  // ==================================================
  const now = new Date();
  
  // Quick in-memory loop (very fast)
  for (const post of posts) {
    const scheduledAt = new Date(post.scheduledAt);
    
    // Check for "Time Travel" or delayed submission
    if (scheduledAt < now) {
      throw new BadRequestException(
        'One or more posts are scheduled in the past. Please re-upload.'
      );
    }

    if (!post.content) {
       throw new BadRequestException('Content is missing in payload');
    }
  }

    // SAVE TO DB
    await this.prisma.$transaction(async (tx) => {
      for (const post of posts) {
        // 1. Create Post
        const createdPost = await tx.post.create({
          data: {
            workspaceId,
            authorId: user.id,
            content: post.content,
            scheduledAt: post.scheduledAt,
            status: 'SCHEDULED',
            timezone: 'UTC',
          },
        });

        // 2. Handle Media (If URL provided)
        // Since it's a CSV URL, we assume it's external.
        // Ideally, you'd trigger a background job here to "Ingest" that URL to your S3.
        if (post.mediaUrl) {
          // Option A: Just save the URL temporarily in metadata
          // Option B: Create a MediaFile (if your model supports external URLs)
        }

        // 3. Create Destinations
        await tx.postDestination.createMany({
          data: post.profileIds.map((profileId) => ({
            postId: createdPost.id,
            socialProfileId: profileId,
            status: 'SCHEDULED',
          })),
        });
      }
    });

    return { status: 'SUCCESS', count: posts.length };
  }

  private ensureBulkFeature(user: any) {
    const features =
      user['features'] || user['organization']?.subscription?.plan?.features;

    if (!features?.bulkScheduling) {
      throw new ForbiddenException(
        'Bulk scheduling is a Business Plan feature.',
      );
    }
  }

  private async parseCsv<T>(buffer: Buffer): Promise<T[]> {
    const results: T[] = [];
    const stream = Readable.from(buffer);

    return new Promise((resolve, reject) => {
      stream
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => resolve(results))
        .on('error', reject);
    });
  }
}
