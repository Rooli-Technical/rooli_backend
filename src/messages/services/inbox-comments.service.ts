import { DomainEventsService } from '@/events/domain-events.service';
import { PrismaService } from '@/prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';

@Injectable()
export class InboxCommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventsService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  /**
   * MACRO VIEW: The Left Sidebar
   * Fetches a list of Posts that have active comments.
   */
  async listPostsWithComments(params: {
    workspaceId: string;
    take: number;
    cursor?: string;
  }) {
    const { workspaceId, take, cursor } = params;

    const posts = await this.prisma.post.findMany({
      where: {
        workspaceId,
        comments: { some: {} }, // Only posts with at least one comment
      },
      take,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        // 1. Get total count across all platforms for this post
        _count: { select: { comments: true } },
        // 2. Get the platform info from the destinations
        destinations: {
          select: {
            profile: { select: { platform: true } },
            platformPostId: true,
          },
          take: 1, // Usually you want the primary platform for the icon
        },
        // 3. Fetch the absolute latest comment
        comments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            content: true,
            senderName: true,
            createdAt: true,
            platform: true,
          },
        },
      },
    });

    // Map the data to match your frontend expectations
    const items = posts.map((post) => {
      const primaryDest = post.destinations[0];
      const latest = post.comments[0] ?? null;

      return {
        id: post.id,
        // Fallback to the platform of the latest comment if destination is missing
        platform:
          latest?.platform ?? primaryDest?.profile?.platform ?? 'UNKNOWN',
        externalPostId: primaryDest?.platformPostId ?? null,
        postContent: post.content,
        createdAt: post.createdAt,
        totalComments: post._count.comments,
        latestComment: latest,
      };
    });

    const nextCursor =
      posts.length === take ? posts[posts.length - 1].id : null;

    return { items, nextCursor };
  }

  /**
   * MICRO VIEW: The Center Chat Window
   * Fetches threaded comments for a specific post.
   */
  async listCommentsForPost(params: {
    workspaceId: string;
    postId: string;
    take: number;
    cursor?: string;
  }) {
    const { workspaceId, postId, take, cursor } = params;

    // Verify post exists
    const post = await this.prisma.post.findUnique({
      where: { id: postId, workspaceId },
    });
    if (!post) throw new NotFoundException('Post not found');

    // Fetch ONLY top-level comments (parentId is null)
    const topLevelComments = await this.prisma.comment.findMany({
      where: {
        workspaceId,
        postId,
        parentId: null, // 👈 This is the magic for threading!
      },
      take,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' }, // Newest top-level comments first
      include: {
        // Include nested replies for each top-level comment
        replies: {
          orderBy: { createdAt: 'asc' }, // Replies read top-to-bottom (chronological)
        },
      },
    });

    const nextCursor =
      topLevelComments.length === take
        ? topLevelComments[topLevelComments.length - 1].id
        : null;

    return {
      post,
      comments: topLevelComments,
      nextCursor,
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
    parentCommentId: string; // The comment the user is replying to
    content: string;
  }) {
    try {
      // 1. Verify the parent comment exists
      const parentComment = await this.prisma.comment.findFirst({
        where: { id: params.parentCommentId, workspaceId: params.workspaceId },
        include: { post: true, profile: true },
      });
      if (!parentComment)
        throw new NotFoundException('Parent comment not found');

      const now = new Date();

      // 2. Save the outbound reply to the database as QUEUED
      const createdComment = await this.prisma.comment.create({
        data: {
          workspaceId: params.workspaceId,
          profileId: parentComment.profileId,
          postId: parentComment.postId,
          parentId: parentComment.id,
          platform: parentComment.platform,
          direction: 'OUTBOUND',
          status: 'VISIBLE',
          senderExternalId: parentComment.profile.platformId,
          content: params.content,
          externalCommentId: `pending_${now.getTime()}_${Math.random().toString(36).slice(2)}`,
        },
      });

      // 3. Queue the job to actually fire the Meta Graph API request
      await this.outboundQueue.add(
        'send-outbound-comment',
        { commentId: createdComment.id },
        {
          jobId: `outbound-comment-${createdComment.id}`,
          attempts: 15,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      );

      // 4. Emit events so the frontend updates the thread immediately
      this.events.emit('inbox.comment.created', {
        workspaceId: params.workspaceId,
        postId: parentComment.postId,
        commentId: createdComment.id,
        direction: 'OUTBOUND',
      });

      return createdComment;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }
}
