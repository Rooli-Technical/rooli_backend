import { Injectable } from '@nestjs/common';
import { TwitterApi } from 'twitter-api-v2';
import { XAuth, XSendResult } from '../types/twitter.types';

@Injectable()
export class TwitterClient {
  /**
   * Create a twitter-api-v2 client per request.
   * This keeps it stateless and makes token handling explicit.
   */
  private makeClient(auth: XAuth): TwitterApi {
    if (auth.mode === 'OAUTH2_BEARER') {
      return new TwitterApi(auth.bearerToken);
    }
    return new TwitterApi({
      appKey: auth.appKey,
      appSecret: auth.appSecret,
      accessToken: auth.accessToken,
      accessSecret: auth.accessSecret,
    });
  }

  /**
   * V2: Send a DM in a DM conversation.
   * Endpoint availability depends on your X access.
   * If your account doesn't have this endpoint, this will fail with 403/404.
   */
  async sendDmV2(params: {
    auth: XAuth; // usually OAUTH2_BEARER or OAUTH1A_USER depending on access
    dmConversationId: string;
    text: string;
  }): Promise<XSendResult> {
    const client = this.makeClient(params.auth);

    // twitter-api-v2 allows calling arbitrary endpoints via client.v2.post()
    // Common pattern: POST /2/dm_conversations/:id/messages
    // NOTE: X may require user-context auth for DMs even if endpoint is v2.
    const res = await client.v2.post(
      `dm_conversations/${encodeURIComponent(params.dmConversationId)}/messages`,
      { text: params.text },
    );

    return {
      provider: 'X',
      messageId: (res as any)?.data?.id ?? (res as any)?.id,
      raw: res,
    };
  }

  /**
   * V1.1: Send a DM using "direct_messages/events/new.json".
   * This is the classic AAAPI/legacy send method and requires OAuth 1.0a user context.
   */
  async sendDmV11(params: {
    auth: Extract<XAuth, { mode: 'OAUTH1A_USER' }>;
    recipientId: string;
    text: string;
  }): Promise<XSendResult> {
    const client = this.makeClient(params.auth);

    const body = {
      event: {
        type: 'message_create',
        message_create: {
          target: { recipient_id: params.recipientId },
          message_data: { text: params.text },
        },
      },
    };

    // v1.1 endpoint call
    const res = await client.v1.post('direct_messages/events/new.json', body);

    return {
      provider: 'X',
      messageId: (res as any)?.event?.id ?? (res as any)?.id,
      raw: res,
    };
  }

  /**
   * Enrichment: lookup user profile by id (username + avatar).
   * Works with either auth mode; bearer is fine for this in most cases.
   */
  async lookupUser(params: { auth: XAuth; userId: string }): Promise<{
    id: string;
    username?: string;
    name?: string;
    profileImageUrl?: string;
    raw: any;
  }> {
    const client = this.makeClient(params.auth);

    // v2 user lookup
    const res = await client.v2.user(params.userId, {
      'user.fields': ['id', 'name', 'username', 'profile_image_url'],
    });

    const u = (res as any)?.data ?? res;
    return {
      id: u?.id,
      username: u?.username,
      name: u?.name,
      profileImageUrl: u?.profile_image_url,
      raw: res,
    };
  }
}
