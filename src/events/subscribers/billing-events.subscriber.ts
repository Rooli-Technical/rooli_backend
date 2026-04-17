import { MailService } from '@/mail/mail.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RealtimeEmitterService } from '../realtime-emitter.service';
import { DomainEventPayloadMap } from '../types/events.types';
import { AdminAlertType } from '@generated/enums';

@Injectable()
export class BillingEventsSubscriber {
  private readonly logger = new Logger(BillingEventsSubscriber.name);

  constructor(
    private readonly mailService: MailService,
    private readonly prisma: PrismaService,
    private readonly realtimeEmitter: RealtimeEmitterService, // Inject this
  ) {}

  @OnEvent('billing.enterprise.requested', { async: true })
  async handleEnterpriseRequested(
    payload: DomainEventPayloadMap['billing.enterprise.requested'],
  ) {
    try {
      const lead = await this.prisma.enterpriseLead.findUnique({
        where: { id: payload.leadId },
      });

      if (!lead) return;

      // 1. Send Emails (Internal Sales Alert + User Confirmation)
      await Promise.all([
        this.mailService.sendEnterpriseLeadInternalAlert(lead),
        this.mailService.sendEnterpriseLeadConfirmation(
          lead.email,
          lead.companyName,
        ),
      ]);

      // ==========================================
      // 🚨 DEDICATED ADMIN NOTIFICATION LOGIC
      // ==========================================

      // Step A: Find all active Super Admins
      // Step A: Find all active Super Admins and Sales Agents
      const admins = await this.prisma.user.findMany({
        where: { 
          globalRole: {
            in: ['SUPER_ADMIN', 'SALES_AGENT'] // Route it to the right staff!
          },
          // isActive: true // (If you have an isActive flag on the User model)
        }, 
        select: { id: true },
      });

      if (admins.length > 0) {
        // Step B: Write directly to the NEW AdminNotification table
        const adminAlertData = admins.map((admin) => ({
          adminId: admin.id,
          type: 'NEW_ENTERPRISE_LEAD' as AdminAlertType,
          title: `🔥 New Enterprise Lead: ${lead.companyName}`,
          body: `${lead.companyName} is requesting a plan with ${lead.workspaces} workspaces.`,
          link: `/admin/enterprise-leads/${lead.id}`,
        }));

        await this.prisma.adminNotification.createMany({
          data: adminAlertData,
        });

        // Step C: Push immediately via WebSockets to your Super Admins
        // (You can emit this to a specific "admin_room" that only admins join on the frontend)
        this.realtimeEmitter.emitToAdmins(
          'admin.notification.created',
          {
            leadId: lead.id,
            companyName: lead.companyName,
            title: `🔥 New Enterprise Lead: ${lead.companyName}`,
          },
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to process enterprise requested event for Lead ${payload.leadId}`,
        error.stack,
      );
    }
  }
}
