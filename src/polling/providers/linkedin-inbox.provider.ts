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
/**
   * Fetches recent LinkedIn comments and maps them to the LinkedIn Webhook format.
   * @param lastPolledAt - Pass a timestamp to prevent re-processing old comments!
   */
async getRecentComments(
    organizationUrn: string,
    postUrns: string[], // 🚨 Accept the array of app-published posts
    accessToken: string,
    lastPolledAt: number,
  ): Promise<any[]> {
    try {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202601',
        'X-Restli-Protocol-Version': '2.0.0',
      };

      const mappedToWebhook: any[] = [];

      // 🚨 Loop directly over the posts from your DB! No need to fetch posts from LinkedIn.
      for (const postUrn of postUrns) {
        const commentsUrl = `${this.baseUrl}/socialActions/${encodeURIComponent(postUrn)}/comments?count=50`;

        try {
          const commentsRes = await firstValueFrom(
            this.httpService.get(commentsUrl, { headers }),
          );

          const comments = commentsRes.data?.elements || [];

          for (const comment of comments) {
            const commentTime = comment.created?.time;

            if (commentTime && commentTime > lastPolledAt) {
              mappedToWebhook.push({
                payload: {
                  actionType: 'COMMENT',
                  organizationalEntity: organizationUrn,
                  actor: comment.actor,
                  commentUrn: comment.object || comment.$URN,
                  socialAction: postUrn,
                  text: comment.message?.text || '',
                  createdAt: commentTime,
                },
              });
            }
          }
        } catch (commentErr: any) {
          const errMsg = commentErr.response?.data ? JSON.stringify(commentErr.response.data) : commentErr.message;
          this.logger.debug(`Skipped comments for post ${postUrn}: ${errMsg}`);
          continue;
        }
      }

      return mappedToWebhook;
    } catch (error: any) {
      const linkedInError = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      this.logger.error(`Failed to fetch LinkedIn comments. Reason: ${linkedInError}`);
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
      console.log('error', JSON.stringify(error));
      const errorMsg = error.response?.data?.message || error.message;
      this.logger.error(`Failed to fetch LinkedIn DMs: ${errorMsg}`);
      return [];
    }
  }
}
