import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class LinkedInInboxProvider {
  private readonly logger = new Logger(LinkedInInboxProvider.name);
  private readonly baseUrl = 'https://api.linkedin.com/rest';

  constructor(private readonly httpService: HttpService) {}

  /**
   * Fetches recent LinkedIn comments and maps them to the LinkedIn Webhook format.
   */
  async getRecentComments(
    organizationUrn: string,
    accessToken: string,
  ): Promise<any[]> {
    try {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202601',
        'X-Restli-Protocol-Version': '2.0.0',
      };

      // 1. Fetch the 5 most recent posts
      // Notice how we must URL encode the URN!
      const postsUrl = `${this.baseUrl}/posts`;
      const postsRes = await firstValueFrom(
        this.httpService.get(postsUrl, {
          headers,
          params: {
            author: organizationUrn,
            q: 'author',
            count: 5,
          },
        }),
      );

      const posts = postsRes.data?.elements || [];
      const mappedToWebhook: any[] = [];
      // 2. Fetch comments for each post
      for (const post of posts) {
        const postUrn = post.id;
        const commentsUrl = `${this.baseUrl}/socialActions/${encodeURIComponent(postUrn)}/comments`;

        try {
          const commentsRes = await firstValueFrom(
            this.httpService.get(commentsUrl, { headers }),
          );

          const comments = commentsRes.data?.elements || [];

          for (const comment of comments) {
            // Fake the LinkedIn Webhook Payload!
            // This perfectly matches what `LinkedInAdapter.normalizeComment` expects.
            mappedToWebhook.push({
              payload: {
                actionType: 'COMMENT',
                organizationalEntity: organizationUrn,
                actor: comment.actor,
                commentUrn: comment.object || comment.$URN,
                socialAction: postUrn,
                text: comment.message?.text || '',
                createdAt: comment.created?.time,
              },
            });
          }
        } catch (commentErr: any) {
          // If comments are disabled on a specific post, it throws a 403.
          // We just catch it and continue to the next post safely.
          this.logger.debug(
            `Skipped comments for post ${postUrn}: ${commentErr.message}`,
          );
          continue;
        }
      }

      return mappedToWebhook;
    } catch (error: any) {
      this.logger.error(`Failed to fetch LinkedIn comments: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetches recent LinkedIn DMs.
   */
  async getRecentDMs(
    organizationUrn: string,
    accessToken: string,
  ): Promise<any[]> {
    try {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202601',
        'X-Restli-Protocol-Version': '2.0.0',
      };

      // Poll the Conversations API
      const url = `${this.baseUrl}/conversations?q=participants&participant=${encodeURIComponent(organizationUrn)}`;
      const { data } = await firstValueFrom(
        this.httpService.get(url, { headers }),
      );

      const messages = data?.elements || [];

      return messages.map((msg: any) => ({
        // Mimicking the LinkedIn 'message' webhook event
        event: {
          id: msg.id,
          origin: msg.origin,
          sender: msg.sender,
          body: msg.body?.text,
          createdAt: msg.createdAt,
          conversationUrn: msg.conversation,
        },
        rawEntry: { id: organizationUrn },
      }));
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message;
      this.logger.error(`Failed to fetch LinkedIn DMs: ${errorMsg}`);
      return [];
    }
  }
}
