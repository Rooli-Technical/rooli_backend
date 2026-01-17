import { PrismaService } from '@/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { AiFactory } from './ai.factory';
import { QuotaService } from './quota.service';


@Injectable()
export class AiService {
  constructor(
    private quotaService: QuotaService, 
    private aiFactory: AiFactory,
    private prisma: PrismaService,
  ) {}

  // SCENARIO 1: TEXT GENERATION
  async generateCaption(user: any, workspaceId: string, prompt: string) {
    
    // 1. CHECK QUOTA (This calls getPlanLimit internally)
    // If limit is reached, this throws an error and stops everything.
    await this.quotaService.checkAndIncrement(user, workspaceId, 'TEXT');

    try {
      // 2. Run AI Logic
      const provider = this.aiFactory.getProvider('OPENAI'); // or dynamic choice
      const result = await provider.generateText(prompt);

      // 3. Log Usage
      await this.prisma.aIUsage.create({ /* ... */ });

      return result;

    } catch (error) {
      // 4. ↩️ REFUND (Critical)
      // If OpenAI crashed, give them their credit back
      await this.quotaService.refundQuota(workspaceId, 'TEXT');
      throw error;
    }
  }

  // 🖼️ SCENARIO 2: IMAGE GENERATION
  async generateImage(user: any, workspaceId: string, prompt: string) {
    
    // 1. 🛑 CHECK QUOTA
    await this.quotaService.checkAndIncrement(user, workspaceId, 'IMAGE');

    try {
      const provider = this.aiFactory.getImageProvider();
      const result = await provider.generateImage(prompt);

      // Save to DB...
      return result;

    } catch (error) {
      // 4. ↩️ REFUND
      await this.quotaService.refundQuota(workspaceId, 'IMAGE');
      throw error;
    }
  }
}
