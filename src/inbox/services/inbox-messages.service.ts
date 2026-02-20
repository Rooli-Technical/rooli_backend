import { PrismaService } from '@/prisma/prisma.service';
import { MessageDirection, DeliveryStatus } from '@generated/enums';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { SendMessageDto } from '../dtos/send-message.dto';

@Injectable()
export class InboxMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    // inject Bull queue (see module below)
    private readonly outboundQueue: Queue,
  ) {}

  private async assertWorkspaceMember(workspaceId: string, memberId: string) {
    const m = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
      select: { id: true },
    });
    if (!m) throw new ForbiddenException('Not a workspace member');
  }

  async listMessages(params: {
    workspaceId: string;
    memberId: string;
    conversationId: string;
    take?: number;
    cursor?: string;
  }) {
    const { workspaceId, memberId, conversationId } = params;
    await this.assertWorkspaceMember(workspaceId, memberId);

    const convo = await this.prisma.inboxConversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');

    const take = Math.min(params.take ?? 50, 200);

    const messages = await this.prisma.inboxMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      include: { attachments: true },
    });

    return {
      items: messages,
      nextCursor:
        messages.length === take ? messages[messages.length - 1].id : null,
    };
  }

  async sendMessage(params: {
    workspaceId: string;
    memberId: string;
    conversationId: string;
    dto: SendMessageDto;
  }) {
    const { workspaceId, memberId, conversationId, dto } = params;
    await this.assertWorkspaceMember(workspaceId, memberId);

    if (
      !dto.content?.trim() &&
      (!dto.attachments || dto.attachments.length === 0)
    ) {
      throw new BadRequestException('Message must have content or attachments');
    }

    const convo = await this.prisma.inboxConversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: {
        id: true,
        socialProfileId: true,
        externalId: true,
        contactId: true,
      },
    });
    if (!convo) throw new NotFoundException('Conversation not found');

    // Create a local outbound message first (QUEUED)
    // externalId is unknown until provider returns it; for outbound you can store a clientGeneratedId in meta,
    // but your schema uses externalId + unique. So: set externalId to a generated temp ID and store provider id later.
    const clientExternalId = `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inboxMessage.create({
        data: {
          conversationId,
          externalId: clientExternalId,
          content: dto.content ?? '',
          direction: MessageDirection.OUTBOUND,
          deliveryStatus: DeliveryStatus.QUEUED as any, // if your enum has QUEUED
          providerTimestamp: null,
          attachments: dto.attachments?.length
            ? {
                create: dto.attachments.map((a) => ({
                  type: a.type as any,
                  url: a.url,
                  mimeType: a.mimeType,
                })),
              }
            : undefined,
        },
        include: { attachments: true },
      });

      // update convo list metadata immediately (so UI shows it)
      await tx.inboxConversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          snippet: (dto.content ?? '').slice(0, 140),
        },
      });

      return created;
    });

    await this.outboundQueue.add(
      'send_outbound_message',
      {
        workspaceId,
        socialProfileId: convo.socialProfileId,
        conversationExternalId: convo.externalId,
        contactId: convo.contactId,
        conversationId,
        messageId: message.id,
      },
      { attempts: 7, backoff: { type: 'exponential', delay: 2000 } },
    );

    return message;
  }
}
