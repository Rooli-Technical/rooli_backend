import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RealtimeEmitterService } from '../realtime-emitter.service';
import { DomainEventPayloadMap } from '../types/events.types';
import { NotificationsService } from '@/notifications/notifications.service';
import { NotificationType } from '@generated/enums';
import { MailService } from '@/mail/mail.service';

@Injectable()
export class TicketEventsSubscriber {
  private readonly logger = new Logger(TicketEventsSubscriber.name);

  constructor(
    private readonly realtimeEmitter: RealtimeEmitterService,
    private readonly email: MailService,
  ) {}

  @OnEvent('ticket.created', { async: true })
  async handleTicketCreated(payload: DomainEventPayloadMap['ticket.created']) {
    this.logger.log(
      `Ticket #${payload.ticketNumber} created. Routing events...`,
    );

    // 1. WEBSOCKETS: Update the UI instantly
    this.realtimeEmitter.emitToWorkspace(
      payload.workspaceId,
      'ticket.created',
      payload,
    );

    // 2. EMAIL: Send confirmation to customer
    // await this.email.sendTicketReceivedEmail(...);
  }

  // I commented this out  since the emit is meant to be to ticketId

  @OnEvent('ticket.comment.added', { async: true })
  async handleCommentAdded(
    payload: DomainEventPayloadMap['ticket.comment.added'],
  ) {
    // 1. WEBSOCKETS: Update the chat thread instantly
    this.realtimeEmitter.emitToWorkspace(
      payload.workspaceId,
      'ticket.comment.added',
      payload,
    );

    // 2. EMAIL: If Admin replied to Customer (and it's not a private note)
    if (payload.isFromSupport && !payload.isInternal) {
      // await this.email.sendTicketReplyEmail(...)
    }
  }

  @OnEvent('ticket.updated', { async: true })
  async handleTicketUpdated(payload: DomainEventPayloadMap['ticket.updated']) {
    console.log('Called  update event ');
    // 1. WEBSOCKETS: Update the status badge (e.g., OPEN -> CLOSED) instantly
    this.realtimeEmitter.emitToWorkspace(
      payload.workspaceId,
      'ticket.updated',
      payload,
    );

    await this.email.sendSupportEmail2(
      payload.email,
      payload.status.toLowerCase(),
    );
  }

  @OnEvent('ticket.comment.reply', { async: true })
  async handleTicketCommentAdded(
    payload: DomainEventPayloadMap['ticket.comment.reply'],
  ) {
    // 1. WEBSOCKETS: Update the chat thread instantly
    this.realtimeEmitter.emitToTicketId(
      payload.ticketId,
      'ticket.comment.reply',
      payload,
    );

    // 2. EMAIL: If Admin replied to Customer (and it's not a private note)
    if (payload.isFromSupport && !payload.isInternal) {
      await this.email.sendSupportEmail(payload.email);
    }
  }
}
