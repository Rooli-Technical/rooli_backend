import axios, { AxiosInstance, AxiosError } from 'axios';
import { Injectable } from '@nestjs/common';
import {
  MetaProfileResult,
  MetaSendMode,
  MetaSendTextRequest,
  MetaSendResult,
  MetaSendAttachmentRequest,
} from '../types/meta.types';

@Injectable()
export class MetaClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: 20_000,
    });
  }

  /**
   * Fetch IG profile data (fields vary by endpoint + permissions).
   * You can call with an IG professional account id (igId).
   */
  async fetchInstagramProfile(params: {
    accessToken: string;
    igId: string;
    fields?: string[];
  }): Promise<MetaProfileResult> {
    const { accessToken, igId } = params;
    const fields = params.fields?.length
      ? params.fields
      : ['id', 'username', 'name', 'profile_picture_url'];

    const baseUrl = this.resolveHost(accessToken);
    const url = `${baseUrl}/${igId}`;

    try {
      const res = await this.http.get(url, {
        params: {
          fields: fields.join(','),
          access_token: accessToken,
        },
      });

      return {
        id: res.data.id,
        username: res.data.username,
        name: res.data.name,
        profile_picture_url: res.data.profile_picture_url,
        raw: res.data,
      };
    } catch (e) {
      throw this.wrapMetaError(e, 'fetchInstagramProfile');
    }
  }

  /**
   * Send a text DM.
   * - PAGE_SEND_API uses /{pageId}/messages or /me/messages style. :contentReference[oaicite:2]{index=2}
   * - IG_MESSAGING_API uses /{igId}/messages. :contentReference[oaicite:3]{index=3}
   */
  async sendText(
    mode: MetaSendMode,
    req: MetaSendTextRequest,
  ): Promise<MetaSendResult> {
    const baseUrl = this.resolveHost(req.accessToken);
    const endpoint = this.resolveSendEndpoint(mode, {
      pageId: req.pageId,
      igId: req.igId,
    });
    const url = `${baseUrl}${endpoint}`;

    const body: any =
      mode === 'IG_MESSAGING_API'
        ? {
            recipient: { id: req.recipient.id },
            message: { text: req.text },
            // access_token goes in query for Graph typically
          }
        : {
            recipient: { id: req.recipient.id },
            message: { text: req.text },
            messaging_type: req.messagingType ?? 'RESPONSE',
          };

    try {
      const res = await this.http.post(url, body, {
        params: { access_token: req.accessToken },
      });
      console.log('Meta sendText response:', res.data);

      return {
        provider: 'META',
        messageId: res.data?.message_id,
        recipientId: res.data?.recipient_id,
        raw: res.data,
      };
    } catch (e) {
      console.log(e);
      throw this.wrapMetaError(e, 'sendText');
    }
  }

  /**
   * Send a media/file attachment by URL.
   */
  async sendAttachment(
    mode: MetaSendMode,
    req: MetaSendAttachmentRequest,
  ): Promise<MetaSendResult> {
    const baseUrl = this.resolveHost(req.accessToken);
    const endpoint = this.resolveSendEndpoint(mode, {
      pageId: req.pageId,
      igId: req.igId,
    });
    const url = `${baseUrl}${endpoint}`;

    const body: any =
      mode === 'IG_MESSAGING_API'
        ? {
            recipient: { id: req.recipient.id },
            message: {
              attachment: {
                type: req.type,
                payload: { url: req.url, is_reusable: req.isReusable ?? false },
              },
            },
          }
        : {
            recipient: { id: req.recipient.id },
            message: {
              attachment: {
                type: req.type,
                payload: { url: req.url, is_reusable: req.isReusable ?? false },
              },
            },
            messaging_type: 'RESPONSE',
          };

    try {
      const res = await this.http.post(url, body, {
        params: { access_token: req.accessToken },
      });

      return {
        provider: 'META',
        messageId: res.data?.message_id,
        recipientId: res.data?.recipient_id,
        raw: res.data,
      };
    } catch (e) {
      throw this.wrapMetaError(e, 'sendAttachment');
    }
  }

  /**
   * Fetch comments live from Meta for a specific post/media.
   */
  async getPostComments(params: {
    accessToken: string;
    externalPostId: string;
    platform: 'FACEBOOK' | 'INSTAGRAM';
  }): Promise<any[]> {
    const baseUrl = this.resolveHost(params.accessToken);
    const url = `${baseUrl}/${params.externalPostId}/comments`;

    // FB and IG return slightly different fields
    const fields =
      params.platform === 'INSTAGRAM'
        ? 'id,text,timestamp,from,replies{id,text,timestamp,from}'
        : 'id,message,created_time,from,comments{id,message,created_time,from}';

    try {
      const res = await this.http.get(url, {
        params: {
          access_token: params.accessToken,
          fields,
          // Limit to 50 top-level comments for MVP
          limit: 50,
        },
      });

      return res.data.data || [];
    } catch (e) {
      console.log(e);
      throw this.wrapMetaError(e, 'getPostComments');
    }
  }

  /**
   * Reply to a public comment on Facebook or Instagram.
   */
  async replyToComment(params: {
    accessToken: string;
    commentId: string; // The parent comment's external ID
    message: string;
    platform: 'FACEBOOK' | 'INSTAGRAM';
  }): Promise<{ id: string; provider: string; raw: any }> {
    const baseUrl = this.resolveHost(params.accessToken);
    const edge = params.platform === 'INSTAGRAM' ? 'replies' : 'comments';
    const endpoint = `${baseUrl}/${params.commentId}/${edge}`;

    try {
      const res = await this.http.post(
        endpoint,
        { message: params.message },
        { params: { access_token: params.accessToken } },
      );

      return {
        provider: 'META',
        id: res.data?.id, // This is the official ID we need to save!
        raw: res.data,
      };
    } catch (e) {
      throw this.wrapMetaError(e, 'replyToComment');
    }
  }

  /**
   * Fetch the profile of the person who sent a DM (Contact Profile)
   * Handles both legacy FB Page routing and the new IG-only tokens.
   */
  async fetchContactProfile(params: {
    senderId: string; // The PSID (Facebook) or IGSID (Instagram)
    platform: 'FACEBOOK' | 'INSTAGRAM';
    accessToken: string; // Either the IG token or the FB Page token
  }): Promise<{
    id: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    avatarUrl?: string;
  }> {
    // 1. Smart Routing based on the Token
    const isIgOnlyToken = params.accessToken.startsWith('IG');
    const baseUrl = isIgOnlyToken
      ? 'https://graph.instagram.com/v23.0'
      : 'https://graph.facebook.com/v23.0';

    // 2. Request the correct fields based on Platform/Token
    let fields = '';
    if (params.platform === 'INSTAGRAM') {
      // Instagram only provides the full name and username.
      fields = 'name,username,profile_pic';
    } else {
      // Facebook provides split first/last names.
      fields = 'first_name,last_name,profile_pic';
    }

    const url = `${baseUrl}/${params.senderId}`;

    try {
      const res = await this.http.get(url, {
        params: {
          fields,
          access_token: params.accessToken,
        },
      });

      const data = res.data;

      // 3. Normalize the response for your Rooli Database
      if (params.platform === 'INSTAGRAM') {
        return {
          id: data.id,
          name: data.name, // "John Doe"
          username: data.username, // "@johndoe"
          avatarUrl: data.profile_pic,
        };
      } else {
        return {
          id: data.id,
          firstName: data.first_name,
          lastName: data.last_name,
          name: `${data.first_name || ''} ${data.last_name || ''}`.trim(),
          avatarUrl: data.profile_pic,
        };
      }
    } catch (e) {
      console.log(
        `Failed to fetch ${params.platform} profile for sender ${params.senderId}`,
      );
      throw this.wrapMetaError(e, 'fetchContactProfile');
    }
  }

  private resolveSendEndpoint(
    mode: MetaSendMode,
    ctx: { pageId?: string; igId?: string },
  ) {
    if (mode === 'IG_MESSAGING_API') {
      if (!ctx.igId)
        throw new Error(
          'MetaClient: igId is required for IG_MESSAGING_API mode',
        );
      // /<IG_ID>/messages :contentReference[oaicite:4]{index=4}
      return `/${ctx.igId}/messages`;
    }

    // PAGE_SEND_API (Messenger Platform style):
    // Usually /me/messages or /{PAGE-ID}/messages :contentReference[oaicite:5]{index=5}
    if (ctx.pageId) return `/${ctx.pageId}/messages`;
    return `/me/messages`;
  }

  private wrapMetaError(err: any, op: string) {
    const e = err as AxiosError<any>;
    const status = e.response?.status;
    const data = e.response?.data;

    const msg =
      data?.error?.message ?? e.message ?? 'MetaClient request failed';

    const code = data?.error?.code ?? data?.error?.error_subcode;

    const out = new Error(`MetaClient.${op} failed: ${msg}`);
    (out as any).status = status;
    (out as any).code = code;
    (out as any).raw = data;
    return out;
  }

  private resolveHost(token: string): string {
    if (token.trim().startsWith('IG')) {
      return 'https://graph.instagram.com/v23.0';
    }
    return 'https://graph.facebook.com/v23.0';
  }
}
