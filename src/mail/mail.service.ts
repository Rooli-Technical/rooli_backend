import { Injectable } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';

@Injectable()
export class MailService {
  constructor(private readonly mailerService: MailerService) {}

  async sendVerificationEmail(email: string, token: string) {
    const verificationUrl = `${process.env.API_URL}/auth/verify-email?token=${token}`;

    await this.mailerService.sendMail({
      to: email,
      subject: 'Verify your Rooli account',
      template: 'verify-email',
      context: {
        verificationUrl,
      },
    });
  }

  async sendPasswordResetEmail(email: string, token: string) {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

    await this.mailerService.sendMail({
      to: email,
      subject: 'Reset your Rooli password',
      template: './reset-password', // 👈 refers to templates/reset-password.hbs
      context: {
        resetUrl,
      },
    });
  }

  async sendInvitationEmail(payload: {
    to: string;
    organizationName: string;
    inviterName: string;
    role: string;
    token: string;
    message: string;
  }) {
    const invitationUrl = `${process.env.FRONTEND_URL}/accept-invitation?token=${payload.token}`;

    await this.mailerService.sendMail({
      to: payload.to,
      subject: `You're invited to join ${payload.organizationName} on Rooli`,
      template: './invitation',
      context: {
        invitationUrl,
        organizationName: payload.organizationName,
        inviterName: payload.inviterName,
        role: payload.role,
        year: new Date().getFullYear(),
        message: payload.message,
        frontendUrl: process.env.FRONTEND_URL,
      },
    });
  }

async sendWelcomeEmail(email: string, userName: string, workspaceName: string) {
  const appDashboardUrl = `${process.env.FRONTEND_URL}/dashboard`;

  await this.mailerService.sendMail({
    to: email,
    subject: `Welcome to Rooli, ${userName}!`,
    template: './welcome', 
    context: {
      userName,
      workspaceName, 
      appDashboardUrl, 
      year: new Date().getFullYear(),
    },
  });
}

}
