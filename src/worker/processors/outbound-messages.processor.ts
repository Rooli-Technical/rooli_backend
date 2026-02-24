import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { MetaClient } from '@/messages/integrations/meta.client';
import { MetaSendMode } from '@/messages/types/meta.types';
import { PrismaService } from '@/prisma/prisma.service';
import { DomainEventsService } from '@/events/domain-events.service';
import { TwitterClient } from '@/messages/integrations/twitter.client';


@Injectable()
@Processor('outbound-messages', { concurrency: 15 })
export class OutboundMessagesProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundMessagesProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaClient,
    private readonly twitter: TwitterClient,
    private readonly events: DomainEventsService,
  ) {
    super();
  }

  async process(job: Job<any>) {
    try {
      if (job.name !== 'send-outbound-message') return;

      const { messageId } = job.data as { messageId: string };
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

      const platform = String(msg.conversation.socialProfile.platform);

      if (platform === 'INSTAGRAM' || platform === 'FACEBOOK') {
        await this.sendMeta(msg);
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

  private async sendMeta(msg: any) {
    const profile = msg.conversation.socialProfile;

    const accessToken: string | undefined =
      profile.metaAccessToken ?? profile.accessToken ?? profile.token;
    if (!accessToken) throw new Error('Missing Meta access token');

    const sendMode: MetaSendMode = (profile.metaSendMode ?? 'PAGE_SEND_API') as MetaSendMode;

    const recipientId: string | undefined = msg.conversation.contact.externalId;
    if (!recipientId) throw new Error('Missing Meta recipient externalId');

    const igId = profile.igAccountId ?? profile.igId;
    const pageId = profile.pageId;

    // Send text (if any)
    let sendRes: any | null = null;
    if (msg.content?.trim()) {
      sendRes = await this.meta.sendText(sendMode, {
        accessToken,
        recipient: { id: recipientId },
        text: msg.content,
        igId,
        pageId,
      });
    }

    // Send attachments (if any)
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      for (const a of msg.attachments) {
        await this.meta.sendAttachment(sendMode, {
          accessToken,
          recipient: { id: recipientId },
          type: mapAttachmentTypeToMeta(a.type),
          url: a.proxyUrl ?? a.url,
          igId,
          pageId,
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.inboxMessage.update({
        where: { id: msg.id },
        data: {
          deliveryStatus: 'SENT' as any,
          providerTimestamp: new Date(),
          errorCode: null,
          errorMessage: null,
          // Recommended: store providerMessageId separately instead of overwriting externalId.
          // providerMessageId: sendRes?.messageId ?? null,
        },
      });

      await tx.inboxConversation.update({
        where: { id: msg.conversationId },
        data: {
          lastMessageAt: new Date(),
          snippet: (msg.content ?? '').slice(0, 140),
        },
      });
    });

    // ✅ announce status update for UI
    this.events.emit('inbox.message.status.updated', {
      workspaceId: msg.conversation.workspaceId,
      conversationId: msg.conversationId,
      messageId: msg.id,
      deliveryStatus: 'SENT',
      providerMessageId: sendRes?.messageId ?? null,
    });
    this.events.emit('inbox.conversation.updated', {
      workspaceId: msg.conversation.workspaceId,
      conversationId: msg.conversationId,
      lastMessageAt: new Date(),
    });
  }

  // ✅ Use twitter-api-v2 v1.1 DM send only (OAuth1 user context)

private async sendX(msg: any) {
  const profile = msg.conversation.socialProfile;

  // --- You said: "I want to use version1" ---
  // That means: v1.1 direct_messages/events/new.json
  // It REQUIRES OAuth 1.0a user tokens.
  const appKey = profile.xConsumerKey ?? profile.consumerKey;
  const appSecret = profile.xConsumerSecret ?? profile.consumerSecret;
  const accessToken = profile.xAccessToken ?? profile.accessToken;
  const accessSecret = profile.xAccessTokenSecret ?? profile.accessTokenSecret;

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
          deliveryStatus: 'SENT' as any, // "accepted by X" (true delivered/read comes later if you support it)
          providerTimestamp: now,
          errorCode: null,
          errorMessage: null,

          // ✅ strongly recommended: store providerMessageId separately
          // providerMessageId: res.messageId ?? null,
          //
          // DO NOT overwrite externalId if it's used for idempotency or unique constraints.
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
