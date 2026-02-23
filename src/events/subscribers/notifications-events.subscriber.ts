import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventsGateway } from '../events.gateway';

/**
 * WebSocket push integration for notifications.
 *
 * When NotificationsService creates a row, it emits:
 * - 'notification.created'
 * - and read events (optional)
 *
 * This subscriber routes those events to Socket.io rooms.
 *
 * IMPORTANT:
 * It's better to emit to a USER room (member-specific),
 * not to the whole workspace.
 */
@Injectable()
export class NotificationsEventsSubscriber {
  constructor(private readonly gateway: EventsGateway) {}

  @OnEvent('notification.created')
  onNotificationCreated(evt: {
    workspaceId: string;
    memberId: string;
    notification: any;
  }) {
    // Emit to member-specific room
    this.gateway.emitToMember(evt.memberId, 'notification.created', evt.notification);

    // Optional: also update workspace-wide counters, etc. (usually not needed)
    // this.gateway.emitToWorkspace(evt.workspaceId, 'notification.created', evt.notification);
  }

  @OnEvent('notification.read')
  onNotificationRead(evt: {
    workspaceId: string;
    memberId: string;
    notificationIds: string[];
    readAt: Date;
  }) {
    this.gateway.emitToMember(evt.memberId, 'notification.read', {
      ids: evt.notificationIds,
      readAt: evt.readAt,
    });
  }

  @OnEvent('notification.read_all')
  onNotificationReadAll(evt: {
    workspaceId: string;
    memberId: string;
    readAt: Date;
  }) {
    this.gateway.emitToMember(evt.memberId, 'notification.read_all', {
      readAt: evt.readAt,
    });
  }
}
