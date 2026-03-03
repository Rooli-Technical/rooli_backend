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
   * MACRO VIEW: The Left Sidebar
   * Fetches a list of Posts that have active comments.
   */
  // async listPostsWithComments(params: {
  //     workspaceId: string;
  //     take: number;
  //     cursor?: string;
  //   }) {
  //     const { workspaceId, take, cursor } = params;

  //     const posts = await this.prisma.post.findMany({
  //       where: {
  //         workspaceId,
  //         comments: { some: {} }, // Only posts with at least one comment
  //       },
  //       take,
  //       skip: cursor ? 1 : 0,
  //       cursor: cursor ? { id: cursor } : undefined,
  //       orderBy: { createdAt: 'desc' },
  //       include: {
  //         // 1. Get total count across all platforms for this post
  //         _count: { select: { comments: true } },
  //         // 2. Get the platform info from the destinations
  //         destinations: {
  //           select: {
  //             profile: { select: { platform: true } },
  //             platformPostId: true,
  //           },
  //           take: 1, // Usually you want the primary platform for the icon
  //         },
  //         // 3. Fetch the absolute latest comment
  //         comments: {
  //           orderBy: { createdAt: 'desc' },
  //           take: 1,
  //           select: {
  //             content: true,
  //             senderName: true,
  //             createdAt: true,
  //             platform: true,
  //           },
  //         },
  //       },
  //     });

  //     // Map the data to match your frontend expectations
  //     const items = posts.map((post) => {
  //       const primaryDest = post.destinations[0];
  //       const latest = post.comments[0] ?? null;

  //       return {
  //         id: post.id,
  //         // Fallback to the platform of the latest comment if destination is missing
  //         platform:
  //           latest?.platform ?? primaryDest?.profile?.platform ?? 'UNKNOWN',
  //         externalPostId: primaryDest?.platformPostId ?? null,
  //         postContent: post.content,
  //         createdAt: post.createdAt,
  //         totalComments: post._count.comments,
  //         latestComment: latest,
  //       };
  //     });

  //     const nextCursor =
  //       posts.length === take ? posts[posts.length - 1].id : null;

  //     return { items, nextCursor };
  //   }

  /**
   * MICRO VIEW: The Center Chat Window
   * Fetches threaded comments for a specific post.
   */
  async listCommentsForPost(params: { workspaceId: string; postId: string }) {
    const { workspaceId, postId } = params;

    // 1. Find the Post and its external ID + Token
    const post = await this.prisma.post.findUnique({
      where: { id: postId, workspaceId },
      include: {
        destinations: {
          include: { profile: true },
        },
      },
    });

    if (!post || !post.destinations.length) {
      throw new NotFoundException('Post or destination not found');
    }

    const dest = post.destinations.find(
      (d) =>
        d.profile.platform === 'FACEBOOK' || d.profile.platform === 'INSTAGRAM',
    );

    // 2. Guard Clause: If no Meta destination exists, stop here
    if (!dest) {
      throw new BadRequestException(
        'This post does not have a Meta (FB/IG) destination.',
      );
    }

    const encryptedToken = dest.profile.accessToken;
    if (!encryptedToken) throw new Error('Missing access token');

    // Decrypt the token
    const accessToken = await this.encryptionService.decrypt(encryptedToken);

    // 3. Fetch LIVE from Meta
    const rawComments = await this.metaClient.getPostComments({
      accessToken,
      externalPostId: dest.platformPostId,
      platform: dest.profile.platform as 'FACEBOOK' | 'INSTAGRAM',
    });

    // 4. Normalize the data for your frontend so FB and IG look identical
    const normalizedComments = rawComments.map((c) => ({
      id: c.id,
      content: c.message || c.text, // FB uses message, IG uses text
      senderName: c.from?.username || c.from?.name || 'Unknown User',
      createdAt: c.created_time || c.timestamp,
      // Map the nested replies if they exist
      replies: (c.comments?.data || c.replies?.data || []).map(
        (reply: any) => ({
          id: reply.id,
          content: reply.message || reply.text,
          senderName:
            reply.from?.username || reply.from?.name || 'Unknown User',
          createdAt: reply.created_time || reply.timestamp,
        }),
      ),
    }));

    return {
      post,
      comments: normalizedComments,
    };
  }

  /**
   * Comment reply:
   * - create OUTBOUND comment
   * - enqueue job so retries don't double-send
   * - emit events so UI shows "sending…" instantly
   */
  // async sendCommentReply(params: {
  //   workspaceId: string;
  //   parentCommentId: string; // The comment the user is replying to
  //   content: string;
  // }) {
  //   try {
  //     // 1. Verify the parent comment exists
  //     const parentComment = await this.prisma.comment.findFirst({
  //       where: { id: params.parentCommentId, workspaceId: params.workspaceId },
  //       include: { post: true, profile: true },
  //     });
  //     if (!parentComment)
  //       throw new NotFoundException('Parent comment not found');

  //     const now = new Date();

  //     // 2. Save the outbound reply to the database as QUEUED
  //     const createdComment = await this.prisma.comment.create({
  //       data: {
  //         workspaceId: params.workspaceId,
  //         profileId: parentComment.profileId,
  //         postId: parentComment.postId,
  //         parentId: parentComment.id,
  //         platform: parentComment.platform,
  //         direction: 'OUTBOUND',
  //         status: 'VISIBLE',
  //         senderExternalId: parentComment.profile.platformId,
  //         content: params.content,
  //         externalCommentId: `pending_${now.getTime()}_${Math.random().toString(36).slice(2)}`,
  //       },
  //     });

  //     // 3. Queue the job to actually fire the Meta Graph API request
  //     await this.outboundQueue.add(
  //       'send-outbound-comment',
  //       { commentId: createdComment.id },
  //       {
  //         jobId: `outbound-comment-${createdComment.id}`,
  //         attempts: 15,
  //         backoff: { type: 'exponential', delay: 2000 },
  //         removeOnComplete: true,
  //         removeOnFail: { age: 7 * 24 * 3600 },
  //       },
  //     );

  //     // 4. Emit events so the frontend updates the thread immediately
  //     this.events.emit('inbox.comment.created', {
  //       workspaceId: params.workspaceId,
  //       postId: parentComment.postId,
  //       commentId: createdComment.id,
  //       direction: 'OUTBOUND',
  //     });

  //     return createdComment;
  //   } catch (error) {
  //     console.error(error);
  //     throw error;
  //   }
  // }

  async sendCommentReply(params: {
  workspaceId: string;
  postId: string;           // We need this to find the access token
  parentCommentId: string;   // The Meta ID of the comment (e.g., "123456789_98765")
  content: string;
}) {
  const { workspaceId, postId, parentCommentId, content } = params;

  // 1. Find the Meta destination for this post
  const post = await this.prisma.post.findUnique({
    where: { id: postId, workspaceId },
    include: {
      destinations: {
        include: { profile: true }
      }
    }
  });

  if (!post) throw new NotFoundException('Post not found');

  // 2. Filter for a Meta destination (FB/IG) that has been published
  const dest = post.destinations.find(d => 
    (d.profile.platform === 'FACEBOOK' || d.profile.platform === 'INSTAGRAM') && 
    d.platformPostId
  );

  if (!dest) {
    throw new BadRequestException('No active Meta destination found for this post.');
  }

  // 3. Get the decrypted token
  const encryptedToken = dest.profile.accessToken;
  if (!encryptedToken) throw new Error('Missing access token');
  const accessToken = await this.encryptionService.decrypt(encryptedToken);

  try {
    // 4. Fire the request directly to Meta (instead of queuing)
    // Note: Meta treats replies as POST requests to /{comment-id}/comments
    const result = await this.metaClient.replyToComment({
      accessToken,
      commentId:parentCommentId, // This must be the external Meta ID
      message: content,
      platform: dest.profile.platform as 'FACEBOOK' | 'INSTAGRAM',
    });

    // 5. Emit event for the frontend with the Meta response
    this.events.emit('inbox.comment.sent', {
      workspaceId,
      postId,
      externalId: result.id, // The ID returned by Meta
      content,
      platform: dest.profile.platform,
    });

    return {
      success: true,
      externalId: result.id,
    };

  } catch (error: any) {
    console.error('Meta API Error:', error.response?.data || error.message);
    throw new BadRequestException('Failed to send reply to Meta');
  }
}
}
