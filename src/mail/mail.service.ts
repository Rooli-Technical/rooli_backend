import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { SendMailClient } from 'zeptomail';
import * as fs from 'fs';
import * as handlebars from 'handlebars';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private client: any;

  constructor(private readonly configService: ConfigService) {
    // Initialize ZeptoMail Client
    this.client = new SendMailClient({
      url: 'https://api.zeptomail.com/v1.1/email',
      token: this.configService.get<string>('ZEPTO_MAIL_TOKEN'),
    });
  }

  /**
   * Helper: Reads a .hbs file and compiles it with data
   */
  private async compileTemplate(
    templateName: string,
    context: any,
  ): Promise<string> {
    const templatesDir = path.join(__dirname, 'templates'); // Ensures it looks in dist/templates
    const templatePath = path.join(templatesDir, `${templateName}.hbs`);

    try {
      const source = fs.readFileSync(templatePath, 'utf8');
      const template = handlebars.compile(source);
      return template(context);
    } catch (error) {
      this.logger.error(
        `Could not find or compile template: ${templateName}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Helper: Sends the actual email via ZeptoMail
   */
  private async sendZeptoMail(to: string, subject: string, htmlBody: string) {
    try {
      await this.client.sendMail({
        from: {
          address: this.configService.get<string>('MAIL_FROM_ADDRESS'),
          name: 'Rooli',
        },
        to: [
          {
            email_address: {
              address: to,
              name: 'User', // You can make this dynamic if needed
            },
          },
        ],
        subject: subject,
        htmlbody: htmlBody,
      });
    } catch (error) {
      this.logger.error('Error sending email via ZeptoMail', error);
      throw error;
    }
  }

  // --- Public Methods (Refactored to use Zepto) ---

  async sendVerificationEmail(email: string, token: string) {
    const verificationUrl = `${this.configService.get('API_URL')}/auth/verify-email?token=${token}`;

    // 1. Compile Template
    const html = await this.compileTemplate('verify-email', {
      verificationUrl,
    });

    // 2. Send via Zepto
    await this.sendZeptoMail(email, 'Verify your Rooli account', html);
  }

  async sendPasswordResetEmail(email: string, token: string) {
    const resetUrl = `${this.configService.get('FRONTEND_URL')}/reset-password?token=${token}`;

    const html = await this.compileTemplate('reset-password', { resetUrl });

    await this.sendZeptoMail(email, 'Reset your Rooli password', html);
  }

  async sendInvitationEmail(payload: {
    to: string;
    contextName: string; // Dynamic: "Acme Corp" OR "Marketing Workspace"
    inviterName: string;
    roleName: string;
    token: string;
    isWorkspaceInvite: boolean; // Helps toggle text in the template
    organizationId: string;
  }) {
    const invitationUrl = `${this.configService.get('FRONTEND_URL')}/accept-invitation?token=${payload.token}&orgId=${payload.organizationId}`;

    const context = {
      invitationUrl,
      contextName: payload.contextName,
      inviterName: payload.inviterName,
      roleName: payload.roleName,
      isWorkspaceInvite: payload.isWorkspaceInvite,
      year: new Date().getFullYear(),
      frontendUrl: this.configService.get('FRONTEND_URL'),
    };

    const html = await this.compileTemplate('invitation', context);

    const subject = payload.isWorkspaceInvite
      ? `You've been added to the ${payload.contextName} workspace`
      : `You're invited to join ${payload.contextName} on Rooli`;

    await this.sendZeptoMail(payload.to, subject, html);
  }

  async sendWelcomeEmail(
    email: string,
    userName: string,
    workspaceName: string,
  ) {
    const appDashboardUrl = `${this.configService.get('FRONTEND_URL')}/dashboard`;

    const context = {
      userName,
      workspaceName,
      appDashboardUrl,
      year: new Date().getFullYear(),
    };

    const html = await this.compileTemplate('welcome', context);

    await this.sendZeptoMail(email, `Welcome to Rooli, ${userName}!`, html);
  }

  async sendPasswordResetOtp(email: string, userName: string, otp: string) {
    const context = {
      userName: userName || 'there',
      otp,
      year: new Date().getFullYear(),
      updateTime: new Date().toLocaleString('en-US', {
        timeZone: 'UTC',
        hour12: true,
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    };

    // Ensure you create a file named 'password-reset-otp.hbs'
    const html = await this.compileTemplate('password-reset-otp', context);

    await this.sendZeptoMail(
      email,
      `${otp} is your Rooli password reset code`,
      html,
    );
  }

  async sendSupportEmail(email: string) {
    const context = {
      year: new Date().getFullYear(),
    };
    // Ensure you create a file named 'password-reset-otp.hbs'
    const html = await this.compileTemplate('admin-support', context);
    await this.sendZeptoMail(
      email,
      `Message from Rooli Admin regarding your support ticket`,
      html,
    );
  }

  async sendSupportEmail2(email: string, status: string) {
    const context = {
      status: status,
      year: new Date().getFullYear(),
    };
    // Ensure you create a file named 'password-reset-otp.hbs'
    const html = await this.compileTemplate('admin-ticket-update', context);
    await this.sendZeptoMail(
      email,
      `Ticket Update from Rooli Admin regarding your support ticket`,
      html,
    );
  }

  async sendReadOnlyWarningEmail(email: string) {
    // Assuming your frontend has a dedicated billing settings page
    const billingUrl = `${this.configService.get('FRONTEND_URL')}/settings/billing`;

    const context = {
      billingUrl,
      year: new Date().getFullYear(),
    };

    const html = await this.compileTemplate('read-only-warning', context);

    await this.sendZeptoMail(
      email,
      'Action Required: Your Rooli workspace is now Read-Only',
      html,
    );
  }

  async sendAccountSuspendedEmail(email: string) {
    const billingUrl = `${this.configService.get('FRONTEND_URL')}/settings/billing`;

    const context = {
      billingUrl,
      year: new Date().getFullYear(),
    };

    const html = await this.compileTemplate('account-suspended', context);

    await this.sendZeptoMail(
      email,
      'Notice: Your Rooli workspace has been suspended',
      html,
    );
  }

  async sendPaymentFailedEmail(email: string, orgName: string) {
    const billingUrl = `${this.configService.get('FRONTEND_URL')}/settings/billing`;

    const context = {
      orgName,
      billingUrl,
      year: new Date().getFullYear(),
    };

    const html = await this.compileTemplate('payment-failed', context);

    await this.sendZeptoMail(
      email,
      `Payment failed for your Rooli workspace: ${orgName}`,
      html,
    );
  }
}
