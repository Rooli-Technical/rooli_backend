import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEventName, DomainEventPayloadMap } from './types/events.types';


@Injectable()
export class DomainEventsService {
  constructor(private readonly emitter: EventEmitter2) {}

   emit<K extends keyof DomainEventPayloadMap>(name: K, payload: DomainEventPayloadMap[K]) {
    this.emitter.emit(name, payload);
  }

  // Optional: if you ever need to await subscribers
  emitAsync<K extends DomainEventName>(name: K, payload: DomainEventPayloadMap[K]) {
    return this.emitter.emitAsync(name, payload);
  }
}
