import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { DomainEventsService } from '@/events/domain-events.service';
import { MessagingOutboundService } from '@/messages/outbound-service/messages.service';
import { CommentOutboundService } from '@/messages/outbound-service/comments.service';

@Injectable()
@Processor('outbound-messages', { concurrency: 15, lockDuration: 120_000 })
export class OutboundMessagesProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundMessagesProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventsService,
    private readonly outboundMessage: MessagingOutboundService,
    private readonly outboundComment: CommentOutboundService,
  ) {
    super();
  }

  async process(job: Job<any>) {
    try {
      switch (job.name) {
        case 'send-outbound-message':
          await this.processOutboundMessage(job);
          break;
        case 'send-outbound-comment':
          await this.processOutboundComment(job);
          break;
        default:
          this.logger.warn(`Unknown outbound job: ${job.name}`);
      }
    } catch (err: any) {
      this.logger.error(
        `Outbound failed [${job.name}] jobId=${job.id}: ${err?.message ?? String(err)}`,
      );
      throw err;
    }
  }

  async processOutboundMessage(job: Job<any>) {
    try {
      const { messageId, memberId } = job.data as {
        messageId: string;
        memberId?: string;
      };
      if (!messageId) throw new Error('Outbound job missing messageId');

      const msg = await this.prisma.inboxMessage.findUnique({
        where: { id: messageId },
        include: {
          attachments: true,
          conversation: { include: { contact: true, socialProfile: true } },
        },
      });
      if (!msg) return;

      // Idempotency: if already SENT/DELIVERED, do nothing
      if (
        msg.deliveryStatus === ('SENT' as any) ||
        msg.deliveryStatus === ('DELIVERED' as any)
      ) {
        return;
      }

      // Set SENDING (best effort)
      await this.prisma.inboxMessage.update({
        where: { id: msg.id },
        data: {
          deliveryStatus: 'SENDING' as any,
          errorCode: null,
          errorMessage: null,
        },
      });

      const platform = String(
        msg.conversation.socialProfile.platform.toUpperCase(),
      );

      if (platform === 'INSTAGRAM' || platform === 'FACEBOOK') {
        await this.outboundMessage.sendMetaMessage(msg, memberId);
        return;
      }

      if (platform === 'TWITTER' || platform === 'X') {
        await this.outboundMessage.sendXMessage(msg);
        return;
      }

      throw new Error(`Unsupported platform: ${platform}`);
    } catch (err: any) {
      this.logger.error(
        `Outbound failed [${job.name}] jobId=${job.id}: ${err?.message ?? String(err)}`,
      );
      throw err;
    }
  }

  private async processOutboundComment(job: Job<any>) {
    const { commentId } = job.data;
    if (!commentId) throw new Error('Outbound job missing commentId');

    // 1. Fetch the pending comment
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      include: {
        parent: true,
        profile: true,
      },
    });

    if (!comment || !comment.parent) return;

    // Idempotency check
    if (!comment.externalCommentId.startsWith('pending_')) {
      return;
    }

    const platform = String(comment.profile.platform.toUpperCase());

    // 2. Route to the correct platform provider
    try {
      if (platform === 'FACEBOOK' || platform === 'INSTAGRAM') {
        await this.outboundComment.sendMetaComment(comment);
        return;
      }

      if (platform === 'LINKEDIN') {
        //await this.outboundComment.sendLinkedInComment(comment);
        return;
      }

      if (platform === 'TWITTER' || platform === 'X') {
        //await this.outboundComment.sendXComment(comment);
        return;
      }

      throw new Error(`Unsupported platform for comments: ${platform}`);
    } catch (error: any) {
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error) {
    if (job.name === 'send-outbound-comment') {
      const { commentId, workspaceId } = job.data;

      this.logger.error(
        `Comment ${commentId} failed to send: ${error.message}`,
      );

      await this.prisma.comment.update({
        where: { id: commentId },
        data: { status: 'FAILED' },
      });

      // 2. Emit event so the UI instantly changes from the "grey clock" to the "red ❗"
      this.events.emit('inbox.comment.updated', {
        workspaceId: workspaceId,
        commentId: commentId,
        status: 'FAILED',
        error: error.message,
      });
    }
  }
}
