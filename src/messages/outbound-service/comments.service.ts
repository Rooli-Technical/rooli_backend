import { EncryptionService } from "@/common/utility/encryption.service";
import { PrismaService } from "@/prisma/prisma.service";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { MetaClient } from "../integrations/meta.client";
import { TwitterClient } from "../integrations/twitter.client";

@Injectable()
export class CommentOutboundService {
   private readonly logger = new Logger(CommentOutboundService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
 private readonly meta: MetaClient,
    private readonly twitter: TwitterClient,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

 async sendMetaComment(comment: any) {
    const encryptedToken = comment.profile.accessToken;
    if (!encryptedToken) throw new Error('Missing Meta access token');
    const accessToken = await this.encryption.decrypt(encryptedToken);

    const metaResponse = await this.meta.replyToComment({
      accessToken,
      commentId: comment.parent.externalCommentId, // Reply to parent ID
      message: comment.content,
      platform: comment.profile.platform as any,
    });

    await this.markCommentSuccess(comment, metaResponse.id, comment.profile.platformId, comment.profile.name);
  }

  // ==========================================
  // X / TWITTER COMMENT REPLY
  // ==========================================
//  async sendXComment(comment: any) {
//     const appKey = this.config.getOrThrow<string>('TWITTER_API_KEY');
//     const appSecret = this.config.getOrThrow<string>('TWITTER_API_SECRET');
    
//     const encAccessToken = comment.profile.accessToken;
//     const encAccessSecret = comment.profile.refreshToken;

//     if (!encAccessToken || !encAccessSecret) {
//       throw new Error('Missing X OAuth1 user tokens');
//     }

//     const accessToken = await this.encryption.decrypt(encAccessToken);
//     const accessSecret = await this.encryption.decrypt(encAccessSecret);

//     // X treats replies just like standard tweets, but with a `reply` parameter pointing to the parent Tweet ID
//     // const res = await this.twitter.replyToTweet({
//     //    auth: { mode: 'OAUTH1A_USER', appKey, appSecret, accessToken, accessSecret },
//     //    text: comment.content,
//     //    replyToTweetId: comment.parent.externalCommentId,
//     // });

//     await this.markCommentSuccess(comment, res.tweetId, comment.profile.platformId, comment.profile.name);
//   }

//   // ==========================================
//   // LINKEDIN COMMENT REPLY
//   // ==========================================
//  async sendLinkedInComment(comment: any) {
//     const encryptedToken = comment.profile.accessToken;
//     if (!encryptedToken) throw new Error('Missing LinkedIn access token');
//     const accessToken = await this.encryption.decrypt(encryptedToken);

//     // Call your LinkedIn client's reply method
//     // Note: LinkedIn replies use the /socialActions/{parentUrn}/comments endpoint
//     // const linkedInResponse = await this.linkedinClient.replyToComment(
//     //   accessToken, 
//     //   comment.parent.externalCommentId, 
//     //   comment.content
//     // );

//     await this.markCommentSuccess(comment, linkedInResponse.id, comment.profile.platformId, comment.profile.name);
//   }

  // ==========================================
  // SUCCESS HANDLER
  // ==========================================
  private async markCommentSuccess(
    comment: any, 
    realExternalId: string, 
    senderPlatformId: string, 
    senderName: string
  ) {
    // 1. Overwrite the temp ID with the real network ID
    await this.prisma.comment.update({
      where: { id: comment.id },
      data: {
        externalCommentId: realExternalId,
        status: 'VISIBLE',
        senderExternalId: senderPlatformId,
        senderName: senderName,
      },
    });

    // 2. Tell the frontend to change the grey clock to "✓ Delivered"
    this.events.emit('inbox.comment.updated', {
      workspaceId: comment.workspaceId,
      commentId: comment.id,
      status: 'VISIBLE',
    });

    this.logger.log(`Successfully sent ${comment.platform} comment reply. ID: ${realExternalId}`);
  }

}