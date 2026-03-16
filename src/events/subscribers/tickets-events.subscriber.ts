import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RealtimeEmitterService } from '../realtime-emitter.service';
import { DomainEventPayloadMap } from '../types/events.types';
import { NotificationsService } from '@/notifications/notifications.service';
import { NotificationType } from '@generated/enums';
import { MailService } from '@/mail/mail.service';


// @Injectable()
// export class TicketEventsSubscriber {
//   private readonly logger = new Logger(TicketEventsSubscriber.name);

//   constructor(
//     private readonly realtimeEmitter: RealtimeEmitterService,
//     private readonly notifications: NotificationsService,
//     private readonly email: MailService,
//   ) {}

//   // ====================================================================
//   // 1. TICKET CREATED
//   // ====================================================================
//   @OnEvent('ticket.created', { async: true })
//   async handleTicketCreated(payload: DomainEventPayloadMap['ticket.created']) {
//     this.logger.log(`Ticket #${payload.ticketNumber} created. Routing events...`);

//     // A. WEBSOCKETS: Tell the customer's UI to update their ticket list
//     this.realtimeEmitter.emitToWorkspace(payload.workspaceId, 'ticket.created', payload);

//     // B. WEBSOCKETS (FUTURE): Blast this to a Super Admin "God Mode" room!
//     // this.realtimeEmitter.emitToAdmins('admin.ticket.new', payload);

//     // C. EMAIL: Send the customer a confirmation so they know you got it
//     // await this.email.sendTicketReceivedEmail(payload.workspaceId, payload.ticketNumber);
//   }

//   // ====================================================================
//   // 2. COMMENT ADDED
//   // ====================================================================
//   @OnEvent('ticket.comment.added', { async: true })
//   async handleCommentAdded(payload: DomainEventPayloadMap['ticket.comment.added']) {
    
//     // A. WEBSOCKETS: Always blast the comment down the pipe so the chat UI updates instantly
//     // (You can use emitToWorkspace, or create a specific emitToTicketRoom method)
//     this.realtimeEmitter.emitToWorkspace(payload.workspaceId, 'ticket.comment.added', payload);

//     // B. CONDITIONAL ROUTING: Who gets the notification?
//     if (payload.isFromSupport && !payload.isInternal) {
//       // 🚨 The Admin replied to the Customer!

//       // 1. Add a Red Bell notification for the customer
//       await this.notifications.create({
//         workspaceId: payload.workspaceId,
//         type: NotificationType.TICKET_UPDATE,
//         title: `Support replied to Ticket #${payload.ticketId}`, // Update payload to include ticket number if needed
//         body: payload.content.substring(0, 100) + '...',
//         link: `/settings/support/${payload.ticketId}`, // React Router link
//       });

//       // 2. Send the customer an email
//       // await this.email.sendTicketReplyEmail(...)

//     } else if (!payload.isFromSupport) {
//       // 🚨 The Customer replied to the Admin!
      
//       // Here, you would notify the ASSIGNED ADMIN that the customer responded.
//       // e.g., Send a slack message to your internal support channel, or an email to the admin.
//     }
//   }

//   // ====================================================================
//   // 3. TICKET UPDATED / CLOSED
//   // ====================================================================
//   @OnEvent('ticket.updated', { async: true })
//   async handleTicketUpdated(payload: DomainEventPayloadMap['ticket.updated']) {
    
//     // A. WEBSOCKETS: Update the UI so the status badge changes from OPEN to CLOSED
//     this.realtimeEmitter.emitToWorkspace(payload.workspaceId, 'ticket.updated', payload);

//     // B. NOTIFICATIONS: If closed, tell the customer
//     if (payload.status === 'CLOSED') {
//       await this.notifications.create({
//         workspaceId: payload.workspaceId,
//         type: NotificationType.TICKET_UPDATE,
//         title: `Ticket Closed`,
//         body: `Your support ticket has been closed.`,
//         link: `/settings/support/${payload.ticketId}`,
//       });
//     }
//   }
// }