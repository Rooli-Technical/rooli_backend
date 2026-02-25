import { PrismaService } from '@/prisma/prisma.service';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DomainEventsService } from '@/events/domain-events.service';
import { InjectQueue } from '@nestjs/bullmq';

@Injectable()
export class InboxMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventsService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  /**
   * Agent reply:
   * - create OUTBOUND message with deliveryStatus=QUEUED
   * - enqueue job (jobId = outbound:<messageId>) so retries don't double-send
   * - emit events so UI shows "sending…" immediately
   */
  async sendReply(params: {
    workspaceId: string;
    memberId: string; // agent
    conversationId: string;
    content: string;
    attachments?: Array<{
      type: string; // AttachmentType
      url: string;
      proxyUrl?: string | null;
      thumbnailUrl?: string | null;
      mimeType?: string | null;
      fileSizeBytes?: number | null;
      meta?: any;
    }>;
  }) {
    try{
    const convo = await this.prisma.inboxConversation.findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      include: { contact: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');


    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.inboxMessage.create({
        data: {
          conversationId: convo.id,
          clientMessageId: `msg_${now.getTime()}_${Math.random().toString(36).slice(2)}`,
          providerMessageId: null,
          content: params.content,
          direction: 'OUTBOUND' as any,
          deliveryStatus: 'QUEUED' as any,
          senderName: null,
          providerTimestamp: null,
          attachments: params.attachments?.length
            ? {
                create: params.attachments.map((a) => ({
                  type: a.type as any,
                  url: a.url,
                  proxyUrl: a.proxyUrl ?? null,
                  thumbnailUrl: a.thumbnailUrl ?? null,
                  mimeType: a.mimeType ?? null,
                  fileSizeBytes: a.fileSizeBytes ?? null,
                  meta: a.meta ?? undefined,
                })),
              }
            : undefined,
        },
        include: { attachments: true },
      });

      await tx.inboxConversation.update({
        where: { id: convo.id },
        data: {
          lastMessageAt: now,
          snippet: (params.content ?? '').slice(0, 140),
        },
      });

      // Mark agent read at send time (optional but nice)
      await tx.conversationReadState.upsert({
        where: {
          conversationId_memberId: {
            conversationId: convo.id,
            memberId: params.memberId,
          },
        },
        update: { lastReadAt: now },
        create: {
          conversationId: convo.id,
          memberId: params.memberId,
          lastReadAt: now,
        },
      });

      return msg;
    });

    await this.outboundQueue.add(
      'send-outbound-message',
      { messageId: created.id },
      {
        jobId: `outbound-${created.id}`,
        attempts: 15,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );

    // UI can show message bubble instantly
    this.events.emit('inbox.message.created', {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      messageId: created.id,
      direction: 'OUTBOUND',
    });
    this.events.emit('inbox.conversation.updated', {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      lastMessageAt: now,
      snippet: (params.content ?? '').slice(0, 140),
    });
    this.events.emit('inbox.message.status.updated', {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      messageId: created.id,
      deliveryStatus: 'QUEUED',
    });

    return created;
  } catch (error) {
    console.error( error);
    throw error
  }
  }
}
