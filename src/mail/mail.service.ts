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
      url: "https://api.zeptomail.com/v1.1/email",
      token: this.configService.get<string>('ZEPTO_MAIL_TOKEN'),
    });
  }

  /**
   * Helper: Reads a .hbs file and compiles it with data
   */
  private async compileTemplate(templateName: string, context: any): Promise<string> {
    const templatesDir = path.join(__dirname, 'templates'); // Ensures it looks in dist/templates
    const templatePath = path.join(templatesDir, `${templateName}.hbs`);
    
    try {
      const source = fs.readFileSync(templatePath, 'utf8');
      const template = handlebars.compile(source);
      return template(context);
    } catch (error) {
      this.logger.error(`Could not find or compile template: ${templateName}`, error);
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
          name: "Rooli",
        },
        to: [
          {
            email_address: {
              address: to,
              name: "User", // You can make this dynamic if needed
            },
          },
        ],
        subject: subject,
        htmlbody: htmlBody,
      });
    } catch (error) {
      this.logger.error('Error sending email via ZeptoMail', error);
      throw error
    }
  }

  // --- Public Methods (Refactored to use Zepto) ---

  async sendVerificationEmail(email: string, token: string) {
    const verificationUrl = `${this.configService.get('API_URL')}/auth/verify-email?token=${token}`;
    
    // 1. Compile Template
    const html = await this.compileTemplate('verify-email', { verificationUrl });
    
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
}) {
  const invitationUrl = `${this.configService.get('FRONTEND_URL')}/accept-invitation?token=${payload.token}`;
  
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

  async sendWelcomeEmail(email: string, userName: string, workspaceName: string) {
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
}
