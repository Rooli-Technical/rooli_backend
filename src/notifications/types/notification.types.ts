import { Prisma } from "@generated/client";
import { NotificationType } from "@generated/enums";

export type CreateNotificationInput = {
  workspaceId: string;
  memberId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Prisma.InputJsonValue | null;
  link?: string | null;

  /**
   * Optional dedupe key. Recommended pattern:
   * - `post:${postId}:published`
   * - `post:${postId}:failed`
   * - `conv:${conversationId}:new_message:${messageId}`
   *
   * If you want hard dedupe, add Prisma unique on (memberId, dedupeKey).
   */
  dedupeKey?: string | null;
};

export type CreateManyNotificationsInput = {
  workspaceId: string;
  memberIds: string[];
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Prisma.InputJsonValue | null;
  link?: string | null;

  /**
   * If you enabled dedupeKey uniqueness, set true.
   * Otherwise leave false.
   */
  skipDuplicates?: boolean;

  /**
   * If you use skipDuplicates, you should include a dedupeKey.
   * We'll suffix memberId to avoid collisions if you enforce @@unique([memberId, dedupeKey]).
   */
  dedupeKey?: string | null;
};
