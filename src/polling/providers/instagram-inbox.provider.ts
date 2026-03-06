import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class InstagramInboxProvider {
  private readonly logger = new Logger(InstagramInboxProvider.name);

  constructor(private readonly httpService: HttpService) {}

  // YOUR BRILLIANT HELPER METHOD
  private resolveHost(token: string): string {
    if (token.trim().startsWith('IG')) {
      return 'https://graph.instagram.com/v23.0'; // Direct IG Login
    }
    return 'https://graph.facebook.com/v23.0';    // Connected via FB Page
  }

  /**
   * Fetches recent Instagram comments (Supports both EA and IG tokens)
   */
  async getRecentComments(igUserId: string, accessToken: string): Promise<any[]> {
    try {
      const baseUrl = this.resolveHost(accessToken);
      
      // Instagram uses /media, NOT /feed!
      const url = `${baseUrl}/${igUserId}/media`;
      
      const { data } = await firstValueFrom(
        this.httpService.get(url, {
          params: {
            // Instagram uses 'text', Facebook uses 'message'
            fields: 'id,comments{id,text,from,timestamp,parent_id}',
            limit: 5,
            access_token: accessToken,
          },
        })
      );

      const posts = data?.data || [];

      
      return posts.flatMap((post) => 
        (post.comments?.data || []).map((comment) => ({
          change: {
            field: 'feed', // Webhooks still call it 'feed' generically
            value: {
              item: 'comment',
              verb: 'add',
              post_id: post.id,
              comment_id: comment.id,
              from: {
                id: comment.from?.id,
                name: comment.from?.username 
              },
              // Map IG's 'text' to 'message' so your MetaAdapter doesn't break
              message: comment.text, 
              // IG uses 'timestamp', FB uses 'created_time'
              created_time: Math.floor(new Date(comment.timestamp).getTime() / 1000),
              parent_id: comment.parent_id,
            },
          },
          rawEntry: { id: igUserId },
          objectType: 'instagram', // Tells the adapter this is IG
        }))
      );
    } catch (error: any) {
      this.logger.error(`Failed to fetch IG comments for ${igUserId}: ${error.response?.data?.error?.message || error.message}`);
      return [];
    }
  }

  /**
   * Fetches recent Instagram DMs
   */
  async getRecentDMs(igUserId: string, accessToken: string): Promise<any[]> {
    try {
      const baseUrl = this.resolveHost(accessToken);
      
      const url = `${baseUrl}/${igUserId}/conversations`;
      const { data } = await firstValueFrom(
        this.httpService.get(url, {
          params: {
            platform: 'instagram', // CRITICAL: Tells Meta we want IG DMs, not Messenger DMs
            fields: 'id,messages{id,message,from,created_time}',
            limit: 5,
            access_token: accessToken,
          },
        })
      );

      const conversations = data?.data || [];
      return conversations.flatMap((conv: any) => 
        (conv.messages?.data || []).map((msg: any) => ({
            messaging: {
              sender: { id: msg.from?.id },
              recipient: { id: igUserId },
              timestamp: new Date(msg.created_time).getTime(),
              message: {
                mid: msg.id,
                text: msg.message,
                is_echo: msg.from?.id === igUserId,
              },
            },
            rawEntry: { id: igUserId },
            objectType: 'instagram',
        })),
      );
    } catch (error: any) {
      this.logger.error(`Failed to fetch IG DMs for ${igUserId}: ${error.response?.data?.error?.message || error.message}`);
      return [];
    }
  }
}