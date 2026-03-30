import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MetaSendMode } from '../types/meta.types';
import { MetaClient } from '../integrations/meta.client';
import { TwitterClient } from '../integrations/twitter.client';

@Injectable()
export class MessagingOutboundService {
  private readonly logger = new Logger(MessagingOutboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly meta: MetaClient,
    private readonly twitter: TwitterClient,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  async sendMetaMessage(msg: any, memberId?: string) {
    const profile = msg.conversation.socialProfile;
    const encryptedToken =
      profile.metaAccessToken ?? profile.accessToken ?? profile.token;
    if (!encryptedToken) throw new Error('Missing Meta access token');

    const accessToken = await this.encryption.decrypt(encryptedToken);
    const sendMode = (profile.metaSendMode ?? 'PAGE_SEND_API') as MetaSendMode;
    const recipientId = msg.conversation.contact.externalId;
    const igId = profile.igAccountId ?? profile.igId;
    const pageId = profile.pageId;

    let finalProviderMessageId: string | null = null;

    try {
      // 1. Send Text
      if (msg.content?.trim()) {
        const res = await this.meta.sendText(sendMode, {
          accessToken,
          recipient: { id: recipientId },
          text: msg.content,
          igId,
          pageId,
        });
        finalProviderMessageId = res?.messageId ?? null;
      }

      // 2. Send Attachments
      if (msg.attachments?.length) {
        for (const a of msg.attachments) {
          const res = await this.meta.sendAttachment(sendMode, {
            accessToken,
            recipient: { id: recipientId },
            type: mapAttachmentTypeToMeta(a.type),
            url: a.proxyUrl ?? a.url,
            igId,
            pageId,
          });
          if (!finalProviderMessageId)
            finalProviderMessageId = res?.messageId ?? null;
        }
      }

      await this.updateMessageSuccess(msg, finalProviderMessageId, memberId);
    } catch (error) {
      await this.handleMessageFailure(msg, error);
    }
  }

  async sendXMessage(msg: any) {
    const profile = msg.conversation.socialProfile;
    const appKey = this.config.getOrThrow<string>('TWITTER_API_KEY');
    const appSecret = this.config.getOrThrow<string>('TWITTER_API_SECRET');
    const accessToken = await this.encryption.decrypt(profile.accessToken);
    const accessSecret = await this.encryption.decrypt(profile.refreshToken);

    try {
      const res = await this.twitter.sendDmV11({
        auth: {
          mode: 'OAUTH1A_USER',
          appKey,
          appSecret,
          accessToken,
          accessSecret,
        },
        recipientId: msg.conversation.contact.externalId,
        text: msg.content ?? '',
      });

      await this.updateMessageSuccess(msg, res.messageId);
    } catch (error) {
      await this.handleMessageFailure(msg, error);
    }
  }

  private async updateMessageSuccess(
    msg: any,
    providerId: string | null,
    memberId?: string,
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.inboxMessage.update({
        where: { id: msg.id },
        data: {
          deliveryStatus: 'SENT',
          providerTimestamp: now,
          providerMessageId: providerId,
        },
      });
      await tx.inboxConversation.update({
        where: { id: msg.conversationId },
        data: {
          lastMessageAt: now,
          snippet: (msg.content ?? 'Sent an attachment').slice(0, 140),
        },
      });
      if (memberId) {
        await tx.conversationReadState.upsert({
          where: {
            conversationId_memberId: {
              conversationId: msg.conversationId,
              memberId,
            },
          },
          update: { lastReadAt: now },
          create: {
            conversationId: msg.conversationId,
            memberId,
            lastReadAt: now,
          },
        });
      }
    });
    this.emitStatus(msg, 'SENT', providerId);
  }

  private async handleMessageFailure(msg: any, error: any) {
    const errorMsg = error?.response?.data?.error?.message || error.message;
    const errorCode =
      error?.response?.data?.error?.code?.toString() || 'API_ERROR';
    await this.prisma.inboxMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: 'FAILED', errorCode, errorMessage: errorMsg },
    });
    this.emitStatus(msg, 'FAILED', null, errorCode, errorMsg);
    throw error;
  }

  private emitStatus(
    msg: any,
    status: string,
    pid: string | null,
    code?: string,
    err?: string,
  ) {
    this.events.emit('inbox.message.status.updated', {
      workspaceId: msg.conversation.workspaceId,
      conversationId: msg.conversationId,
      messageId: msg.id,
      deliveryStatus: status,
      providerMessageId: pid,
      errorCode: code,
      errorMessage: err,
    });
  }
}

function mapAttachmentTypeToMeta(
  type: string,
): 'image' | 'video' | 'audio' | 'file' {
  const t = (type ?? '').toUpperCase();
  if (t === 'IMAGE') return 'image';
  if (t === 'VIDEO') return 'video';
  if (t === 'AUDIO') return 'audio';
  return 'file';
}
