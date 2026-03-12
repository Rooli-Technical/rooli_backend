import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RealtimeEmitterService } from '../realtime-emitter.service';
import { DomainEventPayloadMap } from '../types/events.types';


@Injectable()
export class TicketsEventsSubscriber {
  constructor(private readonly emitterService: RealtimeEmitterService) {}

  @OnEvent('ticket.created', { async: false })
  onTicketCreated(evt: DomainEventPayloadMap['ticket.created']) {
    this.emitterService.emitToWorkspace(evt.workspaceId, 'ticket.created', evt);
  }

  @OnEvent('ticket.comment.added', { async: false })
  onTicketCommentAdded(evt: DomainEventPayloadMap['ticket.comment.added']) {
    this.emitterService.emitToConversation(
      evt.workspaceId, 
      evt.ticketId, 
      'ticket.comment.added', 
      evt
    );
  }

  @OnEvent('ticket.updated', { async: false })
  onTicketUpdated(evt: DomainEventPayloadMap['ticket.updated']) {
    this.emitterService.emitToWorkspace(evt.workspaceId, 'ticket.updated', evt);
  }
}