import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { InviteMemberDto } from './dtos/invite-member.dto';
import { MailService } from '@/mail/mail.service';
import { PrismaService } from '@/prisma/prisma.service';
import { InvitationStatus } from '@generated/enums';

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  async inviteMember(orgId: string, inviterId: string, dto: InviteMemberDto) {
    const [existingUser, role] = await Promise.all([ this.prisma.user.findUnique({
      where: { email: dto.email },
      include: {
        organizationMemberships: {
          where: { organizationId: orgId, isActive: true },
        },
      },
    }), this.prisma.role.findUnique({
      where: { id: dto.roleId },
    }), 
  ]);
    
    if (!role) {
      throw new BadRequestException('Invalid role specified');
    }

    if (existingUser?.organizationMemberships.length > 0) {
      throw new ConflictException(
        'User is already a member of this organization',
      );
    }

    if (!(await this.checkMemberLimit(orgId))) {
      throw new BadRequestException('Organization member limit reached');
    }

    const existingInvitation =
      await this.prisma.organizationInvitation.findFirst({
        where: {
          email: dto.email,
          organizationId: orgId,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
      });

    if (existingInvitation) {
      throw new ConflictException(
        'Pending invitation already exists for this email',
      );
    }

    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);

    const invitation = await this.prisma.organizationInvitation.create({
      data: {
        email: dto.email,
        organizationId: orgId,
        invitedBy: inviterId,
        roleId: role.id,
        message: dto.message,
        token,
        expiresAt,
      },
      include: {
        organization: true,
        inviter: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    // await this.mailService.sendInvitationEmail({
    //   to: dto.email,
    //   organizationName: invitation.organization.name,
    //   inviterName: this.formatInviterName(invitation.inviter),
    //   token,
    //   role: role.name,
    //   message: dto.message,
    // });

    return invitation;
  }

  async acceptInvitation(token: string, userId: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { token },
      include: { organization: true, role: true },
    });

    if (!invitation || invitation.expiresAt < new Date()) {
      throw new NotFoundException('Invalid or expired invitation');
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('Invitation has already been processed');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.email !== invitation.email) {
      throw new BadRequestException(
        'Invitation email does not match user email',
      );
    }

    if (!(await this.checkMemberLimit(invitation.organizationId))) {
      throw new BadRequestException('Organization member limit reached');
    }

    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.organizationMember.create({
        data: {
          organizationId: invitation.organizationId,
          userId,
          roleId: invitation.role.id,
          invitedBy: invitation.invitedBy,
        },
      });

      await tx.organizationInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED' },
      });
      return membership;
    });
  }

  async resendInvitation(invitationId: string, inviterId: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId },
      include: { organization: true, inviter: true, role: true },
    });

    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('Cannot resend a processed invitation');
    }

    const newToken = this.generateToken();
    const newExpiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);

    const updatedInvitation = await this.prisma.organizationInvitation.update({
      where: { id: invitationId },
      data: {
        token: newToken,
        expiresAt: newExpiresAt,
        resentAt: new Date(),
      },
    });

    await this.mailService.sendInvitationEmail({
      to: invitation.email,
      organizationName: invitation.organization.name,
      inviterName: this.formatInviterName(invitation.inviter),
      token: newToken,
      role: invitation.role.name,
      message: invitation.message,
    });

    return updatedInvitation;
  }

  async revokeInvitation(invitationId: string, revokerId: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId },
      include: { organization: true },
    });

    if (!invitation) throw new NotFoundException('Invitation not found');

    const updatedInvitation = await this.prisma.organizationInvitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED' },
    });

    return updatedInvitation;
  }

   async declineInvitation(token: string, currentUserId: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { token },
      include: {
        organization: true,
      },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new BadRequestException('Invitation is no longer active');
    }

    if (invitation.expiresAt < new Date()) {
      await this.prisma.organizationInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.EXPIRED },
      });
      throw new BadRequestException('Invitation has expired');
    }


    return this.prisma.organizationInvitation.update({
      where: { id: invitation.id },
      data: {
        status: InvitationStatus.DECLINED,
      },
    });
  }

  async getOrganizationInvitations(orgId: string) {
    return this.prisma.organizationInvitation.findMany({
      where: { organizationId: orgId },
      include: {
        inviter: { select: { firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async checkMemberLimit(orgId: string): Promise<boolean> {
    const [organization, memberCount] = await this.prisma.$transaction([
      this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { maxMembers: true },
      }),
      this.prisma.organizationMember.count({
        where: { organizationId: orgId, isActive: true },
      }),
    ]);

    return memberCount < (organization?.maxMembers ?? 0);
  }

  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  private formatInviterName(inviter: {
    firstName?: string;
    lastName?: string;
  }) {
    return `${inviter?.firstName ?? ''} ${inviter?.lastName ?? ''}`.trim();
  }
}
