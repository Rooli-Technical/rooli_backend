import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class MetaInboxProvider {
  private readonly logger = new Logger(MetaInboxProvider.name);
  private readonly baseUrl = 'https://graph.facebook.com/v23.0';

  constructor(private readonly httpService: HttpService) {}

  /**
   * Fetches recent comments and maps them to the Meta Webhook format.
   */
  async getRecentComments(pageId: string, accessToken: string): Promise<any[]> {
    try {
      // 1. Fetch the 5 most recent posts AND their comments in a single API call!
      // This is a massive rate-limit saver.
      const url = `${this.baseUrl}/${pageId}/feed`;
      const { data } = await firstValueFrom(
        this.httpService.get(url, {
          params: {
            fields:
              'id,comments{id,message,from{id,name,picture.type(large)},created_time,parent}',
            limit: 5,
            access_token: accessToken,
          },
        }),
      );

      const posts = data?.data || [];
      return posts.flatMap((post) =>
        (post.comments?.data || []).map((comment) => ({
          change: {
            field: 'feed',
            value: {
              item: 'comment',
              verb: 'add',
              post_id: post.id,
              comment_id: comment.id,
              from: comment.from,
              profile_picture: comment.from?.picture?.data?.url || null,
              message: comment.message,
              created_time: Math.floor(
                new Date(comment.created_time).getTime() / 1000,
              ),
              parent_id: comment.parent?.id,
            },
          },
          rawEntry: { id: pageId },
          objectType: 'page',
        })),
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch Meta comments for ${pageId}: ${error.response?.data?.error?.message || error.message}`,
      );
      return [];
    }
  }

  /**
   * Fetches recent DMs and maps them to the Meta Webhook format.
   */
  async getRecentDMs(pageId: string, accessToken: string): Promise<any[]> {
    try {
      const url = `${this.baseUrl}/${pageId}/conversations`;
      const { data } = await firstValueFrom(
        this.httpService.get(url, {
          params: {
            fields: 'id,messages{id,message,from,created_time}',
            limit: 5,
            access_token: accessToken,
          },
        }),
      );

      const conversations = data?.data || [];
      return conversations.flatMap((conv: any) =>
        (conv.messages?.data || []).map((msg: any) => ({
          messaging: {
            sender: { id: msg.from?.id },
            recipient: { id: pageId },
            timestamp: new Date(msg.created_time).getTime(),
            message: {
              mid: msg.id,
              text: msg.message,
              is_echo: msg.from?.id === pageId, // True if we sent the message
            },
          },
          rawEntry: { id: pageId },
        })),
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch Meta DMs for ${pageId}: ${error.message}`,
      );
      return [];
    }
  }
}
