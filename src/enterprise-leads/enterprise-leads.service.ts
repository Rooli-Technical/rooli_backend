import { MailService } from '@/mail/mail.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import { ContactEnterpriseDto } from './dtos/contact-enterprise.dto';
import { DomainEventsService } from '@/events/domain-events.service';

@Injectable()
export class EnterpriseLeadsService {
  private readonly logger = new Logger(EnterpriseLeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly domainEvents: DomainEventsService,
  ) {}

async handleEnterpriseRequest(
    dto: ContactEnterpriseDto,
    userId: string,
    organizationId: string,
    workspaceId: string,
  ) {
    try {
      // 1. SAVE TO DATABASE (Extremely Fast)
      const newLead = await this.prisma.enterpriseLead.create({
        data: {
          companyName: dto.companyName,
          email: dto.email,
          companySize: dto.companySize,
          socialProfiles: dto.socialProfiles,
          workspaces: dto.workspaces,
          primaryGoals: dto.primaryGoals,
          status: 'PENDING',
          userId,
          organizationId,
        },
      });

      // 2. 🚨 EMIT THE EVENT (Instant)
      // We pass the email/companyName so the subscriber doesn't even need 
      // to hit the DB again if it doesn't want to.
      this.domainEvents.emit('billing.enterprise.requested', {
        leadId: newLead.id,
        workspaceId,
        organizationId,
        userId,
        email: dto.email,
        companyName: dto.companyName,
      });

      // 3. RETURN SUCCESS (No waiting for ZeptoMail!)
      return {
        success: true,
        message: 'Your request has been successfully saved and sent to our sales team.',
      };
    } catch (error: any) {
      this.logger.error(`Failed to process Enterprise request: ${error.message}`);
      throw new Error('Could not process your request at this time.');
    }
  }
}
