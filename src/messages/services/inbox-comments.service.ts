import { EncryptionService } from '@/common/utility/encryption.service';
import { DomainEventsService } from '@/events/domain-events.service';
import { PrismaService } from '@/prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { MetaClient } from '../integrations/meta.client';

@Injectable()
export class InboxCommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventsService,
    private readonly encryptionService: EncryptionService,
    private readonly metaClient: MetaClient,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  /**
   * MICRO VIEW: The Center Chat Window
   * Fetches threaded comments for a specific post.
   */
  async listCommentsForPost(params: {
    workspaceId: string;
    platformPostId: string;
  }) {
    const { workspaceId, platformPostId } = params;

    const topLevelComments = await this.prisma.comment.findMany({
      where: {
        workspaceId,
        externalPostId: platformPostId,
        parentId: null, // Only fetch parent comments (threads)
      },
      orderBy: { createdAt: 'asc' }, // Oldest first, so users read top-to-bottom
      include: {
        // Automatically fetch the nested replies for each comment!
        replies: {
          orderBy: { createdAt: 'asc' },
        },
        // Optionally fetch the original post data if it was published via Rooli
        postDestination: {
          select: {
            contentOverride: true,
            post: { select: { content: true } },
            profile: { select: { name: true, picture: true, platform: true } },
          },
        },
      },
    });

    if (topLevelComments.length === 0) {
      return { post: null, comments: [] };
    }

    // 2. Derive the Post information safely (handles both Organic and Rooli posts)
    const referenceComment = topLevelComments[0];
    const profile = referenceComment.postDestination?.profile;

    const postInfo = {
      externalPostId: referenceComment.externalPostId,
      platform: referenceComment.platform,
      content:
        referenceComment.postDestination?.contentOverride ||
        referenceComment.postDestination?.post?.content ||
        'Organic Post (Content unavailable)',
      socialProfileName: profile?.name || 'You',
      socialProfilePicture: profile?.picture || null,
    };

    // 3. Normalize the data into a clean structure for the frontend chat window
    const normalizedComments = topLevelComments.map((c) => ({
      id: c.id,
      externalCommentId: c.externalCommentId,
      content: c.content,
      senderName: c.senderName,
      senderAvatarUrl: c.senderAvatarUrl,
      direction: c.direction, // Tells the UI to render it on the Left (INBOUND) or Right (OUTBOUND)
      status: c.status, // VISIBLE, QUEUED, or FAILED
      createdAt: c.createdAt,
      replies: c.replies.map((reply) => ({
        id: reply.id,
        externalCommentId: reply.externalCommentId,
        content: reply.content,
        senderName: reply.senderName,
        senderAvatarUrl: reply.senderAvatarUrl,
        direction: reply.direction,
        status: reply.status,
        createdAt: reply.createdAt,
      })),
    }));

    return {
      post: postInfo,
      comments: normalizedComments,
    };
  }

  /**
   * Comment reply:
   * - create OUTBOUND comment
   * - enqueue job so retries don't double-send
   * - emit events so UI shows "sending…" instantly
   */
  async sendCommentReply(params: {
    workspaceId: string;
    parentCommentId: string; // The internal DB ID of the comment they are replying to
    content: string;
    memberId: string;
  }) {
    try {
      // 1. Verify the parent comment exists
      const parentComment = await this.prisma.comment.findFirst({
        where: { id: params.parentCommentId, workspaceId: params.workspaceId },
        include: { profile: true },
      });
      if (!parentComment)
        throw new NotFoundException('Parent comment not found');

      const now = new Date();

      // 2. Save the outbound reply to the database as QUEUED
      const createdComment = await this.prisma.comment.create({
        data: {
          workspaceId: params.workspaceId,
          authorMemberId: params.memberId,
          profileId: parentComment.profileId,
          postDestinationId: parentComment.postDestinationId,
          parentId: parentComment.id,
          platform: parentComment.platform,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          senderExternalId: parentComment.profile.platformId,
          externalPostId: parentComment.externalPostId,
          content: params.content,
          externalCommentId: `pending_${now.getTime()}_${Math.random().toString(36).slice(2)}`,
        },
      });

      // 3. Queue the job to actually fire the Meta Graph API request
      await this.outboundQueue.add(
        'send-outbound-comment',
        {
          commentId: createdComment.id,
          workspaceId: params.workspaceId,
          platform: parentComment.platform,
          externalParentId: parentComment.externalCommentId,
        },
        {
          jobId: `outbound-comment-${createdComment.id}`,
          attempts: 1,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        },
      );

      // 4. Emit events so the frontend updates the thread immediately
      this.events.emit('inbox.comment.created', {
        workspaceId: params.workspaceId,
        postDestinationId: parentComment.postDestinationId,
        commentId: createdComment.id,
        direction: 'OUTBOUND',
        platform: parentComment.platform,
        content: params.content,
        senderName: parentComment.profile.name || 'You', // The brand's name
        senderAvatar: parentComment.profile.picture || null, // The brand's logo
        socialProfileId: parentComment.profileId,
        externalPostId: parentComment.externalPostId,
        createdAt: now,
      });

      return createdComment;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async retryCommentReply(workspaceId: string, commentId: string) {
    // 1. Find the failed comment
    const failedComment = await this.prisma.comment.findUnique({
      where: { id: commentId, workspaceId, status: 'FAILED' },
      include: { parent: true },
    });

    if (!failedComment || !failedComment.parent) {
      throw new BadRequestException('Comment cannot be retried.');
    }

    // 2. Flip it back to QUEUED instantly
    await this.prisma.comment.update({
      where: { id: commentId },
      data: { status: 'QUEUED' },
    });

    // 3. Emit event to change the UI back to the "grey clock"
    this.events.emit('inbox.comment.updated', {
      workspaceId: workspaceId,
      commentId: commentId,
      status: 'QUEUED',
    });

    // 4. Throw it back into the queue!
    await this.outboundQueue.add(
      'send-outbound-comment',
      {
        commentId: failedComment.id,
      },
      {
        jobId: `retry-outbound-comment-${failedComment.id}-${Date.now()}`,
        attempts: 1,
        removeOnComplete: true,
      },
    );

    return { success: true, message: 'Retrying message' };
  }
}
