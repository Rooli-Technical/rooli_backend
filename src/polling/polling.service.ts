import { PrismaService } from '@/prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';

@Injectable()
export class PollingService {

  constructor(
      @InjectQueue('inbox-sync') private readonly inboxSyncQueue: Queue,
      private readonly prisma: PrismaService,
    ) {}


  async fetchLiveData(profileId: string) {
  // 1. Verify the profile exists
  const profile = await this.prisma.socialProfile.findUnique({
    where: { id: profileId },
  });

  if (!profile) throw new NotFoundException('Profile not found');

  // 2. Add the single job to the queue
  // We use the platform name to tell the worker which logic to run (Meta, X, etc.)
  await this.inboxSyncQueue.add(
    `sync-${profile.platform.toLowerCase()}`, 
    { 
      profileId: profile.id, 
      platform: profile.platform 
    },
    {
      // Unique JobID prevents spamming the queue if the user clicks "Sync" multiple times
      jobId: `manual-sync-${profile.id}-${Date.now()}`,
      attempts: 3,
      backoff: { 
        type: 'exponential', 
        delay: 5000 
      },
      removeOnComplete: true,
    }
  );

  return { message: 'Sync job queued successfully', profileId: profile.id };
}
}
