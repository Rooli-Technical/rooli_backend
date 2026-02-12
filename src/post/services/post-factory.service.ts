import { Prisma, User } from "@generated/client";
import { PostStatus } from "@generated/enums";
import { Injectable } from "@nestjs/common";
import { CreatePostDto } from "../dto/request/create-post.dto";
import { ThreadItemDto } from "../dto/request/thread-item.dto";

@Injectable()
export class PostFactory {
  async createMasterPost(
    tx: Prisma.TransactionClient,
    userId: string,
    workspaceId: string,
    dto: CreatePostDto,
    status: PostStatus,
  ) {
    const post = await tx.post.create({
      data: {
        workspaceId,
        authorId: userId,
        content: dto.content,
        contentType: dto.contentType,
        status,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        isAutoSchedule: dto.isAutoSchedule ?? false,
        timezone: dto.timezone,
        campaignId: dto.campaignId,
      },
    });

    if (dto.mediaIds?.length) {
      await this.createPostMedia(tx, post.id, dto.mediaIds);
    }

    return post;
  }

  async createThreadPost(
    tx: Prisma.TransactionClient,
    userId: string,
    workspaceId: string,
    parentPostId: string,
    threadItem: ThreadItemDto,
    status: PostStatus,
    rootScheduledAt: Date | null,
    rootTimezone: string | null, // Allow null
    campaignId?: string,
  ) {
    const post = await tx.post.create({
      data: {
        workspaceId,
        authorId: userId,
        content: threadItem.content,
        contentType: 'THREAD',
        status,
        scheduledAt: rootScheduledAt,
        timezone: rootTimezone,
        parentPostId,
        campaignId,
      },
    });

    if (threadItem.mediaIds?.length) {
      await this.createPostMedia(tx, post.id, threadItem.mediaIds);
    }

    return post;
  }

  private async createPostMedia(
    tx: Prisma.TransactionClient,
    postId: string,
    mediaIds: string[],
  ) {
    // Prepare data for createMany
    const data = mediaIds.map((mediaFileId, index) => ({
      postId,
      mediaFileId,
      order: index,
    }));

    await tx.postMedia.createMany({ data });
  }
}