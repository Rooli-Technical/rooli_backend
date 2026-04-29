import { EncryptionService } from '@/common/utility/encryption.service';
import { DomainEventsService } from '@/events/domain-events.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import * as JSONBigInt from 'json-bigint';

const JSONBig = JSONBigInt({ storeAsString: true });

const STUCK_AFTER_MINUTES = 10;
const HARD_TIMEOUT_MINUTES = 60;
const BATCH_SIZE = 50;

@Injectable()
export class TikTokPublishReconciliationService {
  private readonly logger = new Logger(TikTokPublishReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly events: DomainEventsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileStuckPublishes() {
    const stuckBefore = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);

    const stuck = await this.prisma.postDestination.findMany({
      where: {
        status: 'PUBLISHING',
        updatedAt: { lt: stuckBefore },
        platformPostId: { not: null },
        profile: { platform: 'TIKTOK' },
      },
      include: {
        post: true,
        profile: { include: { connection: true } },
      },
      take: BATCH_SIZE,
    });

    if (stuck.length === 0) return;

    this.logger.log(`Reconciling ${stuck.length} stuck TikTok publish(es)`);

    for (const dest of stuck) {
      try {
        await this.reconcileOne(dest);
      } catch (err: any) {
        this.logger.error(
          `Reconciliation failed for destination ${dest.id}: ${err?.message}`,
          err?.stack,
        );
      }
    }
  }

  private async reconcileOne(dest: any) {
    const ageMinutes = (Date.now() - dest.updatedAt.getTime()) / 60_000;

    const accessToken = await this.encryption.decrypt(
      dest.profile.accessToken,
    );

    let tiktokStatus: string | null = null;
    let publicIds: any[] = [];
    let fetchFailed = false;

    try {
      const res = await axios.post(
        'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
        { publish_id: dest.platformPostId },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          transformResponse: [
            (data) => {
              try {
                return JSONBig.parse(data);
              } catch {
                return data;
              }
            },
          ],
        },
      );

      tiktokStatus = res.data?.data?.status ?? null;
      publicIds = res.data?.data?.publicaly_available_post_id ?? [];
    } catch (err: any) {
      fetchFailed = true;
      this.logger.warn(
        `TikTok status fetch failed for publish_id ${dest.platformPostId}: ${err?.message}`,
      );
    }

    if (tiktokStatus === 'PUBLISH_COMPLETE') {
      await this.markSuccess(dest, publicIds);
      return;
    }

    if (tiktokStatus === 'FAILED') {
      await this.markFailed(dest, 'TikTok reported the publish failed.');
      return;
    }

    if (ageMinutes >= HARD_TIMEOUT_MINUTES) {
      const reason = fetchFailed
        ? 'No confirmation received from TikTok and status check failed.'
        : `No confirmation received from TikTok (last status: ${tiktokStatus ?? 'unknown'}).`;
      await this.markFailed(dest, reason);
      return;
    }

    this.logger.log(
      `TikTok destination ${dest.id} still pending (status=${tiktokStatus ?? 'unknown'}, age=${ageMinutes.toFixed(1)}m). Leaving as PUBLISHING.`,
    );
  }

  private async markSuccess(dest: any, publicIds: any[]) {
    let finalVideoId = dest.platformPostId;
    let liveUrl: string | null = null;

    if (publicIds.length > 0) {
      finalVideoId = publicIds[0].toString();
      const rawUsername =
        dest.profile.username ||
        dest.profile.connection?.platformUsername ||
        'tiktok';
      const cleanUsername = rawUsername.replace('@', '');
      liveUrl = `https://www.tiktok.com/@${cleanUsername}/video/${finalVideoId}`;
    }

    await this.prisma.postDestination.update({
      where: { id: dest.id },
      data: {
        status: 'SUCCESS',
        platformPostId: finalVideoId,
        platformUrl: liveUrl,
        publishedAt: new Date(),
        errorMessage: null,
      },
    });

    await this.prisma.post.update({
      where: { id: dest.postId },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });

    const snippet =
      (dest.contentOverride || dest.post.content || 'Media post')
        .replace(/\n/g, ' ')
        .substring(0, 60) + '...';

    this.events.emit('publishing.post.published', {
      workspaceId: dest.post.workspaceId,
      postId: dest.postId,
      postDestinationId: dest.id,
      platform: 'TIKTOK',
      profileName: dest.profile.name,
      snippet,
    });

    this.logger.log(
      `Reconciled TikTok destination ${dest.id} → SUCCESS (videoId=${finalVideoId})`,
    );
  }

  private async markFailed(dest: any, reason: string) {
    await this.prisma.postDestination.update({
      where: { id: dest.id },
      data: {
        status: 'FAILED',
        errorMessage: reason,
      },
    });

    await this.prisma.post.update({
      where: { id: dest.postId },
      data: { status: 'FAILED' },
    });

    const snippet =
      (dest.contentOverride || dest.post.content || 'Media post')
        .replace(/\n/g, ' ')
        .substring(0, 60) + '...';

    this.events.emit('publishing.post.failed', {
      workspaceId: dest.post.workspaceId,
      postId: dest.postId,
      postDestinationId: dest.id,
      platform: 'TIKTOK',
      profileName: dest.profile.name,
      snippet,
      reason,
    });

    this.logger.log(`Reconciled TikTok destination ${dest.id} → FAILED (${reason})`);
  }
}
