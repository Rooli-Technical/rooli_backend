/**
 * Your adapters must translate ugly provider payloads into one clean, internal shape.
 * They should NOT touch DB. They should NOT call external APIs.
 *
 * Adapters may return null when the event is irrelevant (echo messages, system events, etc.)
 */

import {
  NormalizedInboundMessage,
  NormalizedPlatform,
} from '../types/adapter.types';

export interface SocialAdapter {
  readonly platform: NormalizedPlatform;

  /**
   * Normalize a direct message event (DM).
   * Return null if the event is irrelevant.
   */
  normalizeDirectMessage(input: any): NormalizedInboundMessage | null;

  /**
   * Normalize a comment event (or a mention event for platforms without "comments").
   * Return null if the event is irrelevant or unsupported.
   */
  normalizeComment?(input: any): NormalizedInboundMessage | null;

  /**
   * Normalize a mention event (X mentions, etc).
   */
  normalizeMention?(input: any): NormalizedInboundMessage | null;
}
