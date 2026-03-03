import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { MetaClient } from '@/messages/integrations/meta.client';
import { MetaSendMode } from '@/messages/types/meta.types';
import { PrismaService } from '@/prisma/prisma.service';
import { DomainEventsService } from '@/events/domain-events.service';
import { TwitterClient } from '@/messages/integrations/twitter.client';
import { EncryptionService } from '@/common/utility/encryption.service';
import { ConfigService } from '@nestjs/config';


@Injectable()
@Processor('outbound-messages', { concurrency: 15, lockDuration: 120_000,  })
export class OutboundMessagesProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundMessagesProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaClient,
    private readonly twitter: TwitterClient,
    private readonly events: DomainEventsService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
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

      const { messageId, memberId } = job.data as { messageId: string, memberId?: string };
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
      if (msg.deliveryStatus === ('SENT' as any) || msg.deliveryStatus === ('DELIVERED' as any)) {
        return;
      }

      // Set SENDING (best effort)
      await this.prisma.inboxMessage.update({
        where: { id: msg.id },
        data: { deliveryStatus: 'SENDING' as any, errorCode: null, errorMessage: null },
      });

      const platform = String(msg.conversation.socialProfile.platform.toUpperCase());

      if (platform === 'INSTAGRAM' || platform === 'FACEBOOK') {
        await this.sendMeta(msg, memberId);
        return;
      }

      if (platform === 'TWITTER' || platform === 'X') {
        await this.sendX(msg);
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

    // Idempotency: if it doesn't start with "pending_", we already sent it successfully!
    if (!comment.externalCommentId.startsWith('pending_')) {
      return;
    }

    // 2. Make the API Call to Meta
    // Note: You might need to adjust this depending on how your `this.meta` client is set up!
    const encryptedToken =  comment.profile.accessToken;
    if (!encryptedToken) throw new Error('Missing Meta access token');
    const accessToken = await this.encryption.decrypt(encryptedToken);

    try {
      // Assuming your Meta Client has a method for replying to comments
      const metaResponse = await this.meta.replyToComment({
        accessToken,
        commentId: comment.parent.externalCommentId, // We reply to the PARENT's external ID
        message: comment.content,
        platform: comment.profile.platform as any,
      });

      // 3. OVERWRITE THE TEMP ID WITH META'S REAL ID
      await this.prisma.comment.update({
        where: { id: comment.id },
        data: {
          externalCommentId: metaResponse.id, // e.g., "123456_7890"
          status: 'VISIBLE',
        },
      });

      this.logger.log(`Successfully sent comment reply. ID: ${metaResponse.id}`);
    } catch (error: any) {
      // Mark as failed in DB so the UI knows
      await this.prisma.comment.update({
        where: { id: comment.id },
        data: { status: 'HIDDEN' }, // Or whatever failed status you use
      });
      throw error; // Re-throw to trigger BullMQ retry
    }
  }
// Add memberId to the function signature (pass it down from the process() function)
  private async sendMeta(msg: any, memberId?: string) {
    const profile = msg.conversation.socialProfile;

    const encryptedToken: string | undefined =
      profile.metaAccessToken ?? profile.accessToken ?? profile.token;
    
    if (!encryptedToken) throw new Error('Missing Meta access token');

    const accessToken = await this.encryption.decrypt(encryptedToken);
    const sendMode: MetaSendMode = (profile.metaSendMode ?? 'PAGE_SEND_API') as MetaSendMode;

    const recipientId: string | undefined = msg.conversation.contact.externalId;
    if (!recipientId) throw new Error('Missing Meta recipient externalId');

    const igId = profile.igAccountId ?? profile.igId;
    const pageId = profile.pageId;

    let finalProviderMessageId: string | null = null;

    // 👇 1. Wrap the API calls in a Try/Catch
    try {
      // Send text (if any)
      if (msg.content?.trim()) {
        const sendRes = await this.meta.sendText(sendMode, {
          accessToken,
          recipient: { id: recipientId },
          text: msg.content,
          igId,
          pageId,
        });
        finalProviderMessageId = sendRes?.messageId ?? null;
      }

      // Send attachments (if any)
      if (Array.isArray(msg.attachments) && msg.attachments.length) {
        for (const a of msg.attachments) {
          const attachRes = await this.meta.sendAttachment(sendMode, {
            accessToken,
            recipient: { id: recipientId },
            type: mapAttachmentTypeToMeta(a.type),
            url: a.proxyUrl ?? a.url,
            igId,
            pageId,
          });
          // 👇 2. Capture the ID from the attachment if there was no text!
          if (!finalProviderMessageId) {
            finalProviderMessageId = attachRes?.messageId ?? null;
          }
        }
      }

      // --- SUCCESS DB UPDATE ---
      await this.prisma.$transaction(async (tx) => {
        await tx.inboxMessage.update({
          where: { id: msg.id },
          data: {
            deliveryStatus: 'SENT' as any,
            providerTimestamp: new Date(),
            errorCode: null,
            errorMessage: null,
            providerMessageId: finalProviderMessageId,
          },
        });

        await tx.inboxConversation.update({
          where: { id: msg.conversationId },
          data: {
            lastMessageAt: new Date(),
            snippet: (msg.content ?? 'Sent an attachment').slice(0, 140),
          },
        });

        // 👇 3. Clear the unread badge for the agent who sent it!
        if (memberId) {
          await tx.conversationReadState.upsert({
            where: {
              conversationId_memberId: {
                conversationId: msg.conversationId,
                memberId: memberId,
              },
            },
            update: { lastReadAt: new Date() },
            create: {
              conversationId: msg.conversationId,
              memberId: memberId,
              lastReadAt: new Date(),
            },
          });
        }
      });

      // ✅ Announce SUCCESS to UI
      this.events.emit('inbox.message.status.updated', {
        workspaceId: msg.conversation.workspaceId,
        conversationId: msg.conversationId,
        messageId: msg.id,
        deliveryStatus: 'SENT',
        providerMessageId: finalProviderMessageId,
      });

      this.events.emit('inbox.conversation.updated', {
        workspaceId: msg.conversation.workspaceId,
        conversationId: msg.conversationId,
        lastMessageAt: new Date(),
      });

    } catch (error: any) {
      // 👇 --- FAILURE DB UPDATE ---
      const errorMsg = error?.response?.data?.error?.message || error.message;
      const errorCode = error?.response?.data?.error?.code?.toString() || 'API_ERROR';

      await this.prisma.inboxMessage.update({
        where: { id: msg.id },
        data: {
          deliveryStatus: 'FAILED' as any,
          errorCode: errorCode,
          errorMessage: errorMsg,
        },
      });

      // ❌ Announce FAILURE to UI
      this.events.emit('inbox.message.status.updated', {
        workspaceId: msg.conversation.workspaceId,
        conversationId: msg.conversationId,
        messageId: msg.id,
        deliveryStatus: 'FAILED',
        errorCode: errorCode,
        errorMessage: errorMsg,
      });

      // Re-throw so BullMQ knows the job failed and can apply retry/backoff logic
      throw error; 
    }
  }

  // ✅ Use twitter-api-v2 v1.1 DM send only (OAuth1 user context)

private async sendX(msg: any) {
  const profile = msg.conversation.socialProfile;


  // It REQUIRES OAuth 1.0a user tokens.
 //  Pull YOUR App credentials from the environment (.env)
    const appKey = this.config.getOrThrow<string>('TWITTER_API_KEY');
    const appSecret = this.config.getOrThrow<string>('TWITTER_API_SECRET');

    //  Pull the USER'S encrypted tokens from Postgres
    const encAccessToken = profile.accessToken;
    const encAccessSecret =  profile.refreshToken;

    if (!encAccessToken || !encAccessSecret) {
      throw new Error('Missing X OAuth1 user tokens in database');
    }

    //  Decrypt ONLY the user's tokens!
    const accessToken = await this.encryption.decrypt(encAccessToken);
    const accessSecret = await this.encryption.decrypt(encAccessSecret);

  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    throw new Error('Missing X OAuth1 credentials (consumer key/secret + access token/secret)');
  }

  const recipientId: string | undefined = msg.conversation.contact.externalId;
  if (!recipientId) throw new Error('Missing X recipient externalId');

  // Optional: mark as SENDING first (helps UI + prevents “stuck queued”)
  await this.prisma.inboxMessage.update({
    where: { id: msg.id },
    data: { deliveryStatus: 'SENDING' as any, errorCode: null, errorMessage: null },
  });

  try {
    // ✅ NEW twitter client (twitter-api-v2) v1.1 send
    const res = await this.twitter.sendDmV11({
      auth: {
        mode: 'OAUTH1A_USER',
        appKey,
        appSecret,
        accessToken,
        accessSecret,
      },
      recipientId,
      text: msg.content ?? '',
    });

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.inboxMessage.update({
        where: { id: msg.id },
        data: {
          deliveryStatus: 'SENT' as any, 
          providerTimestamp: now,
          errorCode: null,
          errorMessage: null,
          providerMessageId: res.messageId ?? null,
        },
      });

      await tx.inboxConversation.update({
        where: { id: msg.conversationId },
        data: {
          lastMessageAt: now,
          snippet: (msg.content ?? '').slice(0, 140),
        },
      });
    });

    // ✅ Domain events for UI
    this.events.emit('inbox.message.status.updated', {
      workspaceId: msg.conversation.workspaceId,
      conversationId: msg.conversationId,
      messageId: msg.id,
      deliveryStatus: 'SENT',
      providerMessageId: res.messageId ?? null,
    });

    this.events.emit('inbox.conversation.updated', {
      workspaceId: msg.conversation.workspaceId,
      conversationId: msg.conversationId,
      lastMessageAt: now,
      snippet: (msg.content ?? '').slice(0, 140),
    });
  } catch (err: any) {
    const errorCode = err?.data?.errors?.[0]?.code?.toString?.() ?? err?.code ?? err?.name ?? 'X_SEND_FAILED';
    const errorMessage = err?.data?.errors?.[0]?.message ?? err?.message ?? String(err);

    const now = new Date();

    await this.prisma.inboxMessage.update({
      where: { id: msg.id },
      data: {
        deliveryStatus: 'FAILED' as any,
        providerTimestamp: now,
        errorCode: String(errorCode),
        errorMessage: String(errorMessage),
      },
    });

    // ✅ Domain event so UI can show “failed to send”
    this.events.emit('inbox.message.status.updated', {
      workspaceId: msg.conversation.workspaceId,
      conversationId: msg.conversationId,
      messageId: msg.id,
      deliveryStatus: 'FAILED',
      errorCode: String(errorCode),
      errorMessage: String(errorMessage),
    });

    throw err; // let Bull retry if you want
  }
}

}

function mapAttachmentTypeToMeta(type: string): 'image' | 'video' | 'audio' | 'file' {
  const t = (type ?? '').toUpperCase();
  if (t === 'IMAGE') return 'image';
  if (t === 'VIDEO') return 'video';
  if (t === 'AUDIO') return 'audio';
  return 'file';
}
