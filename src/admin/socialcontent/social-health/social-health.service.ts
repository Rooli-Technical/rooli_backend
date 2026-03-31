import { Injectable } from '@nestjs/common';
import { SocialHealthRepository } from './social-health.repository';
import { Platform } from '@generated/enums';
import { QueryPostDto } from './social-health.dto';

@Injectable()
export class SocialHealthService {
  constructor(private readonly repo: SocialHealthRepository) {}

  getPlatformHealth() {
    return this.repo.getPlatformHealth();
  }

  getDeadLetterQueue() {
    return this.repo.getDeadLetterQueue();
  }

  failedPostJobs(query: QueryPostDto) {
    return this.repo.failedPostJobs(query.page, query.limit);
  }
}