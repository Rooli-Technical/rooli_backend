import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as https from 'https';

@Injectable()
export class LinkedInInboxProvider {
  private readonly logger = new Logger(LinkedInInboxProvider.name);
  private readonly baseUrl = 'https://api.linkedin.com/rest';

  constructor(private readonly httpService: HttpService) {}

  private httpsAgent = new https.Agent({
    family: 4, // Force IPv4 (Disable IPv6)
    keepAlive: true,
    timeout: 30000,
  });

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
            this.httpService.get(commentsUrl, {
              headers,
              httpsAgent: this.httpsAgent,
            }),
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
          const errMsg = commentErr.response?.data
            ? JSON.stringify(commentErr.response.data)
            : commentErr.message;
          this.logger.debug(`Skipped comments for post ${postUrn}: ${errMsg}`);
          continue;
        }
      }

      return mappedToWebhook;
    } catch (error: any) {
      const linkedInError = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message;
      this.logger.error(
        `Failed to fetch LinkedIn comments. Reason: ${linkedInError}`,
      );
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

  async resolveActorProfile(actorUrn: string, accessToken: string) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202601',
      'X-Restli-Protocol-Version': '2.0.0',
    };

   const isPerson = actorUrn.includes(':person:');
    
    // Extract the raw ID ("urn:li:organization:70387998" -> "70387998")
    const id = actorUrn.split(':').pop(); 

    // 🚨 THE FIX: Different path structures for People vs. Organizations
    const resourcePath = isPerson ? `people/(id:${id})` : `organizations/${id}`;

    const fields = isPerson
      ? 'firstName,lastName,profilePicture'
      : 'localizedName,vanityName,logoV2';

    try {
     const url = `${this.baseUrl}/${resourcePath}?fields=${fields}`;

      const { data } = await firstValueFrom(
        this.httpService.get(url, { headers, httpsAgent: this.httpsAgent }),
      );
     if (isPerson) {
        const firstName = data.firstName?.localized?.['en_US'] || data.firstName || '';
        const lastName = data.lastName?.localized?.['en_US'] || data.lastName || '';
        
        const elements = data.profilePicture?.['displayImage~']?.elements || [];
        const lastElement = elements[elements.length - 1];
        const avatar = lastElement?.identifiers?.[0]?.identifier || null;

        return {
          name: `${firstName} ${lastName}`.trim() || 'LinkedIn Member',
          avatar: avatar,
        };
      } else {
        const elements = data.logoV2?.['displayImage~']?.elements || [];
        const lastElement = elements[elements.length - 1];
        const avatar = lastElement?.identifiers?.[0]?.identifier || null;

        return {
          name: data.localizedName || data.vanityName || data.name || 'LinkedIn Organization',
          avatar: avatar,
        };
      }
    } catch (error: any) {
      // 🚨 Better Error Extraction: Catch Axios Network vs API errors
      const status = error.response?.status || error.code || 'Unknown';
      const errorDetail = error.response?.data 
        ? JSON.stringify(error.response.data) 
        : error.message;

      this.logger.warn(
        `LinkedIn API Error [${status}]: Failed to resolve ${actorUrn}. Details: ${errorDetail}`,
      );

      return {
        name: isPerson ? 'LinkedIn Member' : 'LinkedIn Organization',
        avatar: null,
      };
    }
  }
}
