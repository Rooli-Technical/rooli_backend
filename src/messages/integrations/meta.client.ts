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

  // Default to Graph API base
  private readonly graphBaseUrl = 'https://graph.facebook.com';

  constructor() {
    this.http = axios.create({
      baseURL: this.graphBaseUrl,
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
    apiVersion?: string; // e.g., "v19.0"
  }): Promise<MetaProfileResult> {
    const { accessToken, igId } = params;
    const fields = params.fields?.length
      ? params.fields
      : ['id', 'username', 'name', 'profile_picture_url'];

    const v = params.apiVersion ?? 'v23.0';

    try {
      const res = await this.http.get(`/${v}/${igId}`, {
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
    opts?: { apiVersion?: string },
  ): Promise<MetaSendResult> {
    const v = opts?.apiVersion ?? 'v23.0';

    const endpoint = this.resolveSendEndpoint(mode, {
      v,
      pageId: req.pageId,
      igId: req.igId,
    });

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
      const res = await this.http.post(endpoint, body, {
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
      console.log(e)
      throw this.wrapMetaError(e, 'sendText');
    }
  }

  /**
   * Send a media/file attachment by URL.
   */
  async sendAttachment(
    mode: MetaSendMode,
    req: MetaSendAttachmentRequest,
    opts?: { apiVersion?: string },
  ): Promise<MetaSendResult> {
    const v = opts?.apiVersion ?? 'v19.0';

    const endpoint = this.resolveSendEndpoint(mode, {
      v,
      pageId: req.pageId,
      igId: req.igId,
    });

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
      const res = await this.http.post(endpoint, body, {
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

  private resolveSendEndpoint(
    mode: MetaSendMode,
    ctx: { v: string; pageId?: string; igId?: string },
  ) {
    if (mode === 'IG_MESSAGING_API') {
      if (!ctx.igId)
        throw new Error(
          'MetaClient: igId is required for IG_MESSAGING_API mode',
        );
      // /<IG_ID>/messages :contentReference[oaicite:4]{index=4}
      return `/${ctx.v}/${ctx.igId}/messages`;
    }

    // PAGE_SEND_API (Messenger Platform style):
    // Usually /me/messages or /{PAGE-ID}/messages :contentReference[oaicite:5]{index=5}
    if (ctx.pageId) return `/${ctx.v}/${ctx.pageId}/messages`;
    return `/${ctx.v}/me/messages`;
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
}
